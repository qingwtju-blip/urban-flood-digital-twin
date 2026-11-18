# 城市内涝水动力过程数字孪生平台
# Urban Flood Hydrodynamic Digital Twin

纯前端（HTML + JS）的城市内涝模拟平台：**DEM 二维地表漫流物理引擎 + ML 代理模型** 双引擎，支持多城市暴雨情景推演、积水过程动画、风险分区与热点识别。

A browser-based urban flood simulation platform with dual engines — a **DEM-based 2D overland-flow physics engine** and an **ML surrogate** (GBDT / RF / XGBoost / LightGBM / CatBoost) — for rapid scenario deduction, waterlogging animation, risk zoning and hotspot identification across multiple Chinese cities.

## 功能 Features

- **多城市推演**：内置 10 个城市主城区/全市域计算域（北京、上海、广州、深圳、成都、杭州、武汉、西安、南京、新昌），搜索或按首字母选择
- **降雨情景**：设计暴雨（GB 50014 城市暴雨强度公式，重现期/历时可选）+ 历史场次回演，支持降雨总量倍率调节
- **双引擎**：水动力 CA 物理引擎（地形驱动二维漫流）与 ML 代理模型（暴雨—地形—积水过程映射，训练一次秒级推演）
- **模型率定**：水文参数在线调整、自动重算、参数组记录比对
- **可视化**：积水深度 / 风险分区 / 最大淹没 / 地形图层切换，积水过程时间轴播放（1×/2×/4×），任意点位过程线探针
- **风险分析**：H-E-V（致灾 H / 暴露 E / 脆弱 V）风险构成、分区内涝问题点排行、风险等级面积构成
- **空天地融合校核**：多源数据（行政边界、DEM、暴雨公式、管网能力、历史灾情、卫星反演）协同率定与精度验证

## 快速开始 Quick Start

```bash
git clone https://github.com/<your-username>/urban-flood-digital-twin.git
cd urban-flood-digital-twin
python -m http.server 8091
```

浏览器打开 <http://127.0.0.1:8091> 即可使用（需本地 HTTP 服务，因数据经 `fetch` 加载）。

> 详细操作步骤、界面说明与常见问题排查，见 **[使用说明书.md](使用说明书.md)**。新人请先读这份。

## 目录结构 Project Structure

```
index.html          入口页面
使用说明书.md        图文操作手册（启动、操作流程、FAQ、二次开发）
css/app.css         样式
js/hydro.js         水动力引擎（二维地表漫流 CA）
js/ml.js            ML 代理模型（GBDT/RF/XGBoost/LightGBM/CatBoost）
js/app.js           主交互与可视化逻辑
js/fusion.js        空天地多源数据融合校核模块
data/cities.json    城市列表与元数据
data/geo/<id>.json  城市行政边界（GCJ-02 区县界，阿里 DataV）
data/dem/<id>.json  城市 DEM 栅格（Mapzen Terrarium 重采样）
```

## 数据来源 Data Sources

- 行政边界：阿里云 DataV.GeoAtlas（区县级，GCJ-02）
- 地形 DEM：Mapzen / AWS Terrarium tiles 重采样
- 暴雨公式：GB 50014 城市暴雨强度公式
- 历史场次：场次雨型 + GPM 空间分布约束
- 管网能力：现状排水标准 + 覆盖度折减
- 不透水率 / 城市化强度：卫星影像推断（估算值）

## 上传到 GitHub Upload

```bash
cd E:\urban-flood-digital-twin
git init
git add .
git commit -m "Urban flood hydrodynamic digital twin platform"
git remote add origin https://github.com/<your-username>/urban-flood-digital-twin.git
git branch -M main
git push -u origin main
```

仓库约 88 MB，低于 GitHub 单文件 100 MB 限制，可直接推送，无需 Git LFS。
开启 GitHub Pages（Settings → Pages → main 分支）后，别人无需下载即可在线访问。

## 已知边界 Limitations

- 模型不解析地下管网拓扑、泵站调度与建筑阻水的精细过程
- 不透水率等参数为卫星推断估算值
- 仅用于教学演示与情景推演，**不作为实时预警或防汛调度依据**

## License

MIT License — 可自由下载、学习、修改与二次开发，转载请注明出处（Qing Wei, Hohai University）。
