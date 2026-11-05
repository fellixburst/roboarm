# M1 控制协议 v1

仅运行模拟设备，云台作为未配置能力预留。会话与命令时限来自 `protocol/validation.js`；模拟运动学、关节限位和速度从 `agents/device/config.json` 读取，不是 SO101 真机标定值。

## HTTP 资源

同源网页和 API 由同一 Node.js 服务提供，不启用跨域请求。没有生产认证、互联网硬件控制或真实设备驱动。会话标识是临时控制凭据，不应共享；`/api/state` 不返回其他会话标识或时钟凭据。

| 方法 / 路径 | 输入 | 输出 |
| --- | --- | --- |
| GET `/api/health` | 无 | `ok`, `mode:simulation`, `realHardware:false` |
| POST `/api/sessions` | 空对象 | `sessionId`, `label`, `clock`, `timing` |
| POST `/api/sessions/:id/heartbeat` | 空对象 | 刷新同一会话、时钟凭据与已有控制租约 |
| DELETE `/api/sessions/:id` | 无 | 撤销会话；停止其全部设备 |
| GET `/api/state` | 可选 `X-Session-Id` 请求头 | 设备、真实命令生命周期、最近日志；仅对请求会话计算 `owned` |
| POST `/api/commands` | 下方命令信封 | 同步完成 `200`；目标仍在运动 `202`；拒绝 `400` |
| POST `/api/simulate` | `{sessionId,deviceId,type}` | 注入 `disconnect/reconnect/fault/clear-fault` |
| GET `/api/camera/frame.svg` | 无 | 最大 960×540 SVG 模拟画面，服务端共享缓存 500 ms；离线 `503` |
| GET `/api/vision/stereo` | 无 | 同帧左右图与深度 URL、合成目标、模拟标定与同步状态 |
| GET `/api/camera/left.svg`、`right.svg`、`depth.svg` | 可选 `frameId` | 指定帧的图像；过期帧 `410`、未知帧 `404`、相机离线 `503` |
| POST `/api/vision/stereo/control` | `{sessionId,action,exposureMs?}` | `pause/resume/set-exposure`；曝光 0.1–50 ms，记录操作日志 |
| GET `/api/ptz` | 无 | `ptz-1` 水平和俯仰轴能力；始终为 `reserved/configured:false` |
| POST `/api/ptz/commands` | 标准命令信封 | 复用主命令入口校验；未配置时 `NOT_CONFIGURED` |

请求体最多 16 KiB；设备和日志历史有界。模拟相机是独立小型资源，不经过控制命令队列，不使用摄像头权限、视频编码或无界流。

## 命令信封

```json
{
  "version": 1,
  "deviceId": "arm-1",
  "sessionId": "由会话接口创建",
  "commandId": "每个命令唯一的 UUID",
  "sequence": 3,
  "clockToken": "最近一次会话或心跳响应中的 clock.token",
  "ttlMs": 1000,
  "action": "jog",
  "params": {"jointId": "joint-1", "delta": 5, "speed": 15}
}
```

`sequence` 在同一浏览器会话中全局严格递增，重新建立会话后从 1 开始。合法且通过时间校验的命令会消耗序号，即使设备随后拒绝参数或控制权。设备适配器也独立检查每会话每设备序号。未知设备不执行。

相同会话和 `commandId` 的完全相同信封只返回原命令记录（`duplicate:true`），绝不再执行；改变任何字段会以 `DUPLICATE_CONFLICT` 拒绝。服务保留活动会话全部命令标识，超过 10,000 条时撤销会话要求重新连接；原设备缓存之外还有序号防重放。失效会话先于幂等缓存验证，因此旧会话不能借重复请求重新运动。

| action | 设备 | params / 单位 |
| --- | --- | --- |
| `acquire` | 机械臂、小车 | `{}`；互斥获取控制权，不启用、不运动 |
| `enable` | 机械臂、小车 | `{}`；持有控制权后显式启用 |
| `stop` | 机械臂、小车 | `{}`；任一有效会话可请求软件停止，不授予控制权 |
| `release` | 机械臂、小车 | `{}`；停止、禁用并释放控制权 |
| `jog` | `arm-1` | `jointId:joint-1..joint-5`, `delta:度`, `speed:度/秒`；按速率逐步到达限位内目标 |
| `cartesian-jog` | `arm-1` | `frame:base`, `axis:x/y/z`, `deltaMm:毫米`, `speedMmS:毫米/秒`；步长绝对值 ≤10 mm，速度 >0 且 ≤30 mm/s |
| `grip` | `arm-1` | `position:0..100`，百分比开度；模拟最大速率 60%/秒 |
| `drive` | `car-1` | `linear:米/秒`, `angular:弧度/秒`；最大绝对值 0.3 与 0.8 |
| `ptz-jog` | `ptz-1` 预留 | `axis:pan/tilt`, `deltaDeg:度`, `speedDegS:度/秒`；未配置硬件时拒绝，不运动 |

非有限数字、类型错误、越界位置与超速均拒绝；拒绝不改变当前运动目标或位置。下发零速度也执行停止并禁用。相机 `camera-1` 没有运动控制权。

坐标点动以基座 X 前、Y 左、Z 上为参考，先检查整段路径的解析极值、奇异点和逆解，再沿笛卡尔直线插补。保持末端俯仰与滚转，偏航随基座旋转；不能提供任意六自由度姿态约束。关节、夹爪和坐标目标的冲突会取消旧命令并标记失败；被拒绝的新轨迹保留旧目标。具体模型与扩展接口见 [坐标、双目和云台说明](../docs/EXTENSIONS.md)。

## 有效期与三个停止层

浏览器与服务**不比较本地墙上时钟**。服务在创建会话、接收心跳时发行随机 `clockToken`，在服务自身 `performance.now()` 中记住发行瞬间。`ttlMs` 从该凭据发行时刻起算，范围 1–1000 ms，并非从命令到达后重新计时。浏览器收到凭据后立刻使用，因此网络往返会消耗有效期，拥塞只会让命令更早被拒绝。UI 的 ISO 时间只用于展示。

服务转发命令时同时发送剩余预算与绝对单调截止时刻。M1 的服务和 worker 属于同一 Node.js 进程，共享 `performance.now()` 的进程时间基准；设备在真正执行时再次校验截止时刻，排队不会延长有效期。后续跨主机适配器必须改用接收端发行的时间凭据或往返预算，不能把该进程时间直接传到另一主机比较。

1. 浏览器：每 250 ms 更新会话心跳；按住小车每约 150 ms 发新意图；松手、取消指针、失焦、页面隐藏、切换设备和退出时发停止并清空本地意图。没有离线运动队列。
2. 服务：独立 50 ms 监视；1200 ms 未收心跳撤销控制租约，1800 ms 会话过期；会话关闭、断线和故障立即撤销。重新连接建立新会话。
3. 设备：独立 worker 每 50 ms 用自身单调时间监视租约；仅实际浏览器心跳转发续租。450 ms 未收到新小车意图立即零速度并禁用，浏览器心跳不能掩盖运动意图丢失。转发心跳同样携带进程单调截止时刻，积压心跳不能恢复过期租约。

默认禁用。停止、租约失效、断线、故障、释放控制权均取消未完成关节和夹爪目标、零化小车速度并禁用。设备 `generation` 在停止时递增；停止前排队的旧代次运动不能越过重新启用屏障。重连与清除故障均不自动恢复，必须重新获取控制权并显式启用。

## 状态、生命周期和错误

`/api/state` 中每个设备包含 `id/name/type/mode/connected/enabled/fault/owned/ownerLabel/generation/updatedAt/lastSeenAt/stopReason`。`fault` 为 `null` 或 `{code,message}`。机械臂附 `joints[{id,name,position,min,max,maxSpeed}]`、`gripper`、正运动学 `endEffector`、`linkPointsMm` 和 `kinematics`；小车附 `velocity/pose/limits`。顶层 `capabilities` 提供双目与云台端口。单位见上表。真实硬件永远不显示已连接。

命令记录包含 `commandId/deviceId/action/sequence/sessionLabel/status/receivedAt/updatedAt/transitions`。状态为 `received → executing → completed`，或 `received → rejected`，或运动被打断后的 `failed`。每次转换有独立时间；HTTP 接收不等于完成。关节和夹爪到达目标后才 `completed`；`drive` 的 `completed` 仅表示设备已经应用速度意图，不表示行程完成。停止、断线、目标被覆盖会让原未完成运动记录变为 `failed`。

设备状态新鲜度基于 `lastSeenAt`；UI 只在连接正常且状态未超过 1500 ms 时显示在线。网络失败后控件禁用，重新连接不回放先前动作。

常用错误码：`PROTOCOL_VERSION`、`INVALID_COMMAND`、`INVALID_JSON`、`BODY_TOO_LARGE`、`SESSION_EXPIRED`、`CLOCK_EXPIRED`、`EXPIRED`、`OUT_OF_ORDER`、`DUPLICATE_CONFLICT`、`UNKNOWN_DEVICE`、`NOT_OWNER`、`BUSY`、`NOT_ENABLED`、`OFFLINE`、`DEVICE_FAULT`、`OUT_OF_RANGE`、`INVALID_JOINT`、`UNSUPPORTED_ACTION`、`STALE_GENERATION`、`DEVICE_TIMEOUT`、`DEVICE_UNAVAILABLE`。HTTP 错误响应为 `{error:{code,message},command?}`；被拒绝命令和原因保留在日志中。

扩展错误码：`INVALID_CARTESIAN_PARAMS`、`WORKSPACE_LIMIT`、`IK_UNREACHABLE`、`JOINT_LIMIT`、`INVALID_VISION_ACTION`、`CAMERA_OFFLINE`、`FRAME_NOT_FOUND`、`FRAME_EXPIRED`、`NOT_CONFIGURED`。PTZ 始终先经过标准信封的协议、会话、时钟、序号与幂等校验，再返回未配置错误。
