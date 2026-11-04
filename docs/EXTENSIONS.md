# 坐标点动、双目视觉和双轴云台接口

本页描述 M1 模拟扩展。坐标模型、相机图像、深度和目标都来自模拟；云台尚未配置，不访问电机、摄像头或通信端口。

## 基座坐标系直线点动

在机械臂控制区切换到坐标模式，获取控制权并启用后，可沿 X 前后、Y 左右、Z 上下点动。坐标原点位于机械臂基座，位置单位为毫米；步长最多 10 mm，速度最多 30 mm/s。关节模式与坐标模式共用同一套控制权、限位、命令有效期和停止路径。

命令仍发送到 `POST /api/commands`，使用 v1 标准信封，动作及参数如下：

```json
{
  "action": "cartesian-jog",
  "deviceId": "arm-1",
  "params": {"frame": "base", "axis": "z", "deltaMm": 5, "speedMmS": 10}
}
```

必须同时提供协议版本、会话、命令标识、递增序号、时钟票据和有效期，见 [完整命令信封](../protocol/README.md)。示例片段不能直接代替完整信封。

模拟模型位于 `agents/device/config.json` 的 `kinematics`。基座高度 100 mm、上臂 120 mm、前臂 120 mm、工具长度 60 mm，仅用于演示，不是 SO101 尺寸或标定数据。五关节模型保持当前末端俯仰和滚转，偏航随基座旋转，不能约束完整六自由度姿态。

服务端设备适配器先检查整段路径的工作空间、关节角和可达范围的解析极值及奇异点，并在不超过 0.25 mm 间隔处检查逆运动学解，再沿笛卡尔直线逐点求解关节位置。实际速度同时受末端请求速度和各关节速度上限约束。不可达、逆解越过关节限位、工作空间越界等均在替换旧目标前拒绝。点动通过校验后取消相冲突的关节或夹爪目标，停止、断线与租约失效会中断路径并标记原命令失败。

`GET /api/state` 中机械臂新增：

- `endEffector`：`frame/xMm/yMm/zMm/pitchDeg/rollDeg`，由当前关节正运动学计算。
- `linkPointsMm`：基座、肩、肘、腕、工具的五个实际模型节点，用于同一坐标系下的视图投影。
- `kinematics`：明确标为模拟的模型、方向和限制。

坐标相关错误码：`INVALID_CARTESIAN_PARAMS`、`OUT_OF_RANGE`、`WORKSPACE_LIMIT`、`IK_UNREACHABLE`、`JOINT_LIMIT`。运动中的停止、目标替换与生命周期规则沿用原协议。

## 双目视觉资源与控制

| 端口 | 用途 |
| --- | --- |
| GET `/api/vision/stereo` | 双目状态、同帧资源 URL、模拟参数、深度和合成目标 |
| GET `/api/camera/left.svg?frameId=…` | 指定帧的左图 |
| GET `/api/camera/right.svg?frameId=…` | 同一帧的右图 |
| GET `/api/camera/depth.svg?frameId=…` | 与左图像素对齐的模拟深度图 |
| POST `/api/vision/stereo/control` | 暂停、恢复或设置模拟曝光 |
| GET `/api/camera/frame.svg` | 保留原单画面接口，兼容已有使用方式 |

控制请求需要有效会话，例如 `{"sessionId":"…","action":"pause"}`、`{"sessionId":"…","action":"resume"}`，或 `{"sessionId":"…","action":"set-exposure","exposureMs":8}`。曝光允许 0.1–50 ms。操作及结果写入服务日志，不获取机械臂或小车运动控制权。

元数据包含 `available/status/streaming/frameId/capturedAt`、`frames.left/right/depth`、`synchronization`、`calibration` 和 `detections`。使用元数据返回的 URL 请求同一帧，不能分别获取三个不带帧号的最新资源来假定同步。暂停时保留最后一组成对图像，`streaming:false`，恢复后生成新帧；`exposureMs` 表示当前设置，`frameExposureMs` 表示冻结图像采集时的曝光，避免把新设置误当成旧帧的参数。图像限制为 2 FPS，只保留最近 6 帧；已淘汰帧返回 `410 FRAME_EXPIRED`，不存在帧返回 `404 FRAME_NOT_FOUND`。

合成场景使用 960×540 针孔模型，焦距 480 px、基线 60 mm。目标距离为场景几何真值，左右视差满足 `disparityPx = focalLengthPx × baselineMm / depthMm`。目标框使用对应图像的像素坐标。`confidence:1` 是合成场景的确定性标记，不是识别模型置信度；深度图也不是从真实左右图估计的结果。

相机坐标系为 X 向右、Y 向下、Z 向前，和机械臂基座坐标系不同。相机到机械臂的外参 `calibration.robotTransform` 保持 `null`；未经真机内外参标定，不将图像像素或深度直接转换为机械臂抓取命令。

相机离线或故障时，元数据明确显示不可用，清空当前图像 URL 和目标列表；图像及控制请求返回 `503 CAMERA_OFFLINE`。合成图像、目标和参数始终有模拟标记。

## 双电机云台预留

`GET /api/ptz` 返回 `ptz-1` 的预留能力，分为水平旋转 `pan` 和俯仰 `tilt` 两轴。`mode:"reserved"`、`configured:false`、`connected:false`，位置为 `null`。角度和速度限制仅为接口示例，不是电机标定结果，云台不计入在线设备数。

预留动作如下，使用标准命令信封发送至 `/api/ptz/commands` 或 `/api/commands`：

```json
{
  "deviceId": "ptz-1",
  "action": "ptz-jog",
  "params": {"axis": "pan", "deltaDeg": 2, "speedDegS": 5}
}
```

入口检查协议、会话、时钟、序号和重复命令后，未配置云台返回 `NOT_CONFIGURED` 并记录拒绝原因。不会仅凭重连、故障注入或请求启用就显示电机运行成功。

这里的“端口”是服务 API 与设备适配接口。设备通信类型、串口路径或网络地址、电机编号、GPIO/PWM 引脚、零位、方向和硬限位均待型号确定后配置；没有预先占用 USB、串口或 GPIO。预留传输类型为串口、CAN 和 TCP，不能据此推断硬件已支持它们。

真机接入时需分别实现相机采集与同步、内外参标定，以及云台驱动、位置反馈、限位和设备端超时。真实驱动应接入既有的命令校验、互斥控制、限速和停止机制，不能绕开它们。
