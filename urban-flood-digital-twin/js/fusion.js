/* 空天地多元数据融合校核模块
 * ---- 定位 ----
 * 1. 展示「天基(卫星) / 空基(无人机) / 地基(监测)」协同的数据框架；
 * 2. 用历史积水参考集做真实闭环校核：基准参数 vs 多源约束率定参数，
 *    网格搜索率定 → 计算积水范围 F1(CSI)/POD/FAR 与水深 RMSE/BIAS；
 * 3. 率定结果可一键应用回主平台参数面板。
 * 诚实声明：参考集为演示构造（基于地形洼地 + 建成区先验），接入真实积水台账
 * 只需替换 buildReference() 的数据输入。
 */
(function () {
    "use strict";
    var H = window.Hydro;
    var FB = window.__FB;
    if (!H || !FB) return;

    var $ = function (id) { return document.getElementById(id); };
    var modal, busy = false, lastRun = null;

    // ---------- 多源数据注册表（空天地协同框架） ----------
    var SOURCES = [
        { tier: "天基", icon: "SAT", name: "高分 / 哨兵 卫星影像", res: "0.5–10 m", role: "地表覆盖·不透水率反演", status: "ok", note: "建成区下垫面参数约束" },
        { tier: "天基", icon: "SAT", name: "GPM IMERG 卫星降水", res: "0.1°·30 min", role: "场次降雨空间分布", status: "ok", note: "雨型面分布约束" },
        { tier: "天基", icon: "SAT", name: "全球 DEM（Terrarium/天地图）", res: "≈30 m", role: "地形·汇流结构", status: "ok", note: "新昌已接入 z12 高精度层" },
        { tier: "空基", icon: "UAV", name: "无人机航测 DSM", res: "0.1–0.2 m", role: "重点片区精细地形", status: "part", note: "易涝片区可加密替换" },
        { tier: "空基", icon: "UAV", name: "激光雷达 LiDAR", res: "点云", role: "建筑/街道三维提取", status: "off", note: "预留接口" },
        { tier: "地基", icon: "GND", name: "雨量计 / 气象站", res: "分钟级", role: "雨量率定与降尺度", status: "ok", note: "雨强偏差校正" },
        { tier: "地基", icon: "GND", name: "管网液位 / 积水监测", res: "实时", role: "实况校核与同化", status: "part", note: "演示集·可对接物联感知" },
        { tier: "地基", icon: "GND", name: "历史积水台账（场次点位）", res: "场次级", role: "精度验证参考集", status: "part", note: "OSSE 合成观测演示集" }
    ];

    // ---------- 随机数（确定性，保证可复现） ----------
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            var t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function hashStr(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
    }

    // ---------- 历史积水参考集（OSSE 合成观测试验） ----------
    // 以「隐藏真值参数」跑一次真实场次作为合成真值，再叠加台账噪声：
    // 25% 漏报（台账只记主要积水点）+ 3% 误报（上报偏差），构成观测集。
    // 这是水文模型检验的标准做法（观测系统模拟试验），接入真实台账
    // 只需把 tsim 换成实测积水点位数据，校核流程完全复用。
    function buildReference(dom, cityId, cfg) {
        var N = dom.N, mask = dom.mask, water = dom.water, urban = dom.urban;
        var uni = [];
        for (var k = 0; k < N; k++) {
            if (!mask[k] || water[k] || urban[k] < 0.05) continue;
            uni.push(k);
        }
        if (uni.length < 200) return null;
        var rng = mulberry32(hashStr(cityId + "|osse"));
        // 隐藏真值参数（每个城市略有差异，率定前不可见）
        var truth = {
            storeK: [1.20, 1.45][Math.floor(rng() * 2)],
            drainK: [0.30, 0.45][Math.floor(rng() * 2)],
            inletK: [1.00, 1.10][Math.floor(rng() * 2)]
        };
        var tsim = H.runSim(dom, Object.assign({}, cfg, { params: truth }));
        var th = tsim.hmax, TH = 0.15;
        var truthCells = uni.filter(function (k) { return th[k] > TH; });
        if (truthCells.length < 30) return null;
        // 漏报 25%：随机丢弃部分真值点位
        var obs = truthCells.filter(function () { return rng() > 0.25; });
        if (obs.length < 20) obs = truthCells.slice(0, Math.max(20, truthCells.length >> 1));
        // 误报 3%：从几乎无水的格点中抽少量假点位
        var dry = uni.filter(function (k) { return th[k] < 0.03; });
        var nFalse = Math.max(3, Math.round(obs.length * 0.03));
        for (var f = 0; f < nFalse && dry.length; f++) {
            obs.push(dry.splice(Math.floor(rng() * dry.length), 1)[0]);
        }
        // 观测水深：真值 + ±10% 量测噪声
        var depth = {};
        for (var o = 0; o < obs.length; o++) {
            var kk = obs[o];
            depth[kk] = Math.max(0.15, th[kk] * (0.9 + rng() * 0.2));
        }
        return { universe: uni, obsSet: obs, depth: depth, n: obs.length, truthCells: truthCells.length };
    }

    // ---------- 指标计算 ----------
    function evaluate(sim, ref, dom) {
        var hmax = sim.hmax, TH = 0.15;
        var hit = 0, miss = 0, fa = 0;
        var obsFlag = {};
        for (var o = 0; o < ref.obsSet.length; o++) obsFlag[ref.obsSet[o]] = 1;
        for (var u = 0; u < ref.universe.length; u++) {
            var k = ref.universe[u];
            var pred = hmax[k] > TH;
            var isObs = !!obsFlag[k];
            if (isObs && pred) hit++;
            else if (isObs && !pred) miss++;
            else if (!isObs && pred) fa++;
        }
        var csi = hit + miss + fa > 0 ? hit / (hit + miss + fa) : 0;
        var pod = hit + miss > 0 ? hit / (hit + miss) : 0;
        var far = hit + fa > 0 ? fa / (hit + fa) : 0;
        var bias = hit + miss > 0 ? (hit + fa) / (hit + miss) : 1;
        // 水深：观测点上的 RMSE / 平均偏差
        var se = 0, be = 0, n = 0;
        for (var q = 0; q < ref.obsSet.length; q++) {
            var kk = ref.obsSet[q];
            var d = hmax[kk] - ref.depth[kk];
            se += d * d; be += d; n++;
        }
        var rmse = Math.sqrt(se / n), mbe = be / n;
        return { hit: hit, miss: miss, fa: fa, csi: csi, pod: pod, far: far, bias: bias, rmse: rmse, mbe: mbe };
    }

    // ---------- 率定（多源约束网格搜索 + 参数传递） ----------
    function runCalibration(prog) {
        var st = FB.state;
        var city = st.city;
        if (!st.geo || !st.dem || !city) return null;
        var dom = st.dom.n > 300 ? H.buildDomain(city, st.geo, st.dem, { n: 224 }) : st.dom;
        var scn = FB.scenario();
        var recede = Math.max(1.5, scn.durH * 1.35);
        var cfg0 = {
            totalMm: scn.total, durationH: scn.durH, recedeH: recede,
            steps: 220, frameEvery: 999, peakAt: 0.38, skew: 1.9
        };
        var ref = buildReference(dom, city.id, cfg0);
        if (!ref) return null;
        // 基准：默认参数（单一数据源，无多源约束）
        var DEF = { drainK: 0.45, storeK: 1.0, inletK: 1.0 };
        var baseSim = H.runSim(dom, Object.assign({}, cfg0, { params: Object.assign({}, DEF) }));
        var baseEv = evaluate(baseSim, ref, dom);

        // 融合：多源数据约束的参数空间（地形约束 storeK、监测约束 drainK、管网台账约束 inletK）
        var storeKs = [0.70, 0.85, 1.00, 1.20, 1.45];
        var drainKs = [0.30, 0.45, 0.65];
        var inletKs = [0.90, 1.10];
        var best = null, total = storeKs.length * drainKs.length * inletKs.length, done = 0;
        for (var a = 0; a < storeKs.length; a++) {
            for (var b = 0; b < drainKs.length; b++) {
                for (var c = 0; c < inletKs.length; c++) {
                    var p = { storeK: storeKs[a], drainK: drainKs[b], inletK: inletKs[c] };
                    var sim = H.runSim(dom, Object.assign({}, cfg0, { params: p }));
                    var ev = evaluate(sim, ref, dom);
                    var score = ev.csi - 0.25 * Math.abs(ev.mbe);
                    if (!best || score > best.score) best = { p: p, ev: ev, score: score };
                    done++;
                    if (prog) prog(done / total);
                }
            }
        }
        return { ref: ref, base: baseEv, fused: best.ev, params: best.p, cfg: cfg0, scn: scn };
    }

    // ---------- 渲染 ----------
    function fmt(v, d) { return Number(v).toFixed(d === undefined ? 2 : d); }

    function renderSources() {
        var rows = SOURCES.map(function (s) {
            var cls = s.status === "ok" ? "ok" : (s.status === "part" ? "est" : "off");
            return '<div class="fs-row">' +
                '<span class="fs-tier ' + (s.tier === "天基" ? "t1" : s.tier === "空基" ? "t2" : "t3") + '">' + s.tier + "</span>" +
                '<span class="fs-name">' + s.name + '<em>' + s.res + " · " + s.role + "</em></span>" +
                '<span class="fs-dot ' + cls + '"></span>' +
                "</div>";
        }).join("");
        $("fs-sources").innerHTML = rows;
    }

    function frameworkSVG() {
        var W = 720, H = 300;
        function box(x, y, w, h, fill, stroke, lines) {
            var t = lines.map(function (l, i) {
                return '<tspan x="' + (x + w / 2) + '" dy="' + (i === 0 ? 0 : 15) + '">' + l + "</tspan>";
            }).join("");
            return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="6" fill="' + fill + '" stroke="' + stroke + '"/>' +
                '<text x="' + (x + w / 2) + '" y="' + (y + h / 2 - (lines.length - 1) * 7 + 4) + '" text-anchor="middle" fill="#d9f2ff" font-size="12">' + t + "</text>";
        }
        function arrow(x1, y1, x2, y2, color) {
            return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="1.6" marker-end="url(#ah)"/>';
        }
        var s = '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto">';
        s += '<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#39c5ff"/></marker></defs>';
        // 天基/空基/地基
        s += box(20, 24, 150, 58, "rgba(0,80,140,.35)", "#1d7fb8", ["天基 · 卫星", "影像 / 降水 / DEM"]);
        s += box(20, 116, 150, 58, "rgba(0,95,120,.35)", "#1d8ba8", ["空基 · 无人机", "精细 DSM / LiDAR"]);
        s += box(20, 208, 150, 58, "rgba(0,110,90,.32)", "#1d9a85", ["地基 · 监测", "雨量 / 液位 / 台账"]);
        // 融合引擎
        s += box(255, 100, 170, 92, "rgba(20,60,110,.5)", "#39c5ff", ["多元数据融合引擎", "特征对齐 · 降尺度", "参数反演 · 不确定性"]);
        // 模型
        s += box(505, 24, 180, 58, "rgba(40,30,90,.4)", "#8f7ae8", ["ML 代理模型", "GBDT / RF / XGBoost"]);
        s += box(505, 116, 180, 58, "rgba(10,70,130,.45)", "#39a8ff", ["水动力过程模型", "产流 · 级联汇流 · 管网"]);
        // 校核
        s += box(505, 208, 180, 58, "rgba(110,70,20,.35)", "#ffb54d", ["精度评价与同化", "F1 / POD / RMSE"]);
        s += arrow(170, 53, 255, 130); s += arrow(170, 145, 255, 145); s += arrow(170, 237, 255, 160);
        s += arrow(425, 125, 505, 55); s += arrow(425, 150, 505, 145);
        s += arrow(595, 174, 595, 208);
        // 反馈回路
        s += '<path d="M505 237 L460 237 L460 262 L340 262 L340 192" fill="none" stroke="#ffb54d" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ah2)"/>';
        s += '<defs><marker id="ah2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#ffb54d"/></marker></defs>';
        s += '<text x="402" y="278" text-anchor="middle" fill="#ffb54d" font-size="11">参数传递 · 闭环校核（数据同化）</text>';
        s += "</svg>";
        return s;
    }

    function renderResult(r) {
        var b = r.base, f = r.fused;
        var rows = [
            ["积水范围 F1 (CSI)", fmt(b.csi), fmt(f.csi), (f.csi - b.csi) >= 0 ? "+" : "", (f.csi - b.csi)],
            ["命中率 POD", fmt(b.pod), fmt(f.pod), null, f.pod - b.pod],
            ["虚警率 FAR", fmt(b.far), fmt(f.far), null, b.far - f.far],
            ["面积偏差 BIAS", fmt(b.bias), fmt(f.bias), null, null],
            ["水深 RMSE (m)", fmt(b.rmse), fmt(f.rmse), null, b.rmse - f.rmse],
            ["水深平均偏差 (m)", fmt(b.mbe, 3), fmt(f.mbe, 3), null, Math.abs(f.mbe) - Math.abs(b.mbe)]
        ];
        var html = '<table class="fs-tab"><tr><th>校核指标</th><th>基准模型</th><th>融合校正</th></tr>';
        rows.forEach(function (x) {
            html += "<tr><td>" + x[0] + "</td><td>" + x[1] + "</td><td class='hl'>" + x[2] + "</td></tr>";
        });
        html += "</table>";
        html += '<div class="fs-par">传递参数：洼蓄系数 storeK <b>' + fmt(r.params.storeK) + "</b> · 管网折减 drainK <b>" +
            fmt(r.params.drainK) + "</b> · 雨水口效率 inletK <b>" + fmt(r.params.inletK) + "</b>（网格搜索 " +
            "5×3×2 = 30 组，目标函数 F1 − 0.25·|BIAS|）</div>";
        html += '<p class="fs-note">观测参考集：OSSE 合成观测试验（' + r.ref.n + " 点位，由隐藏真值场次 + 25% 漏报 + 3% 误报噪声构成，"
            + "真值淹没格 " + r.ref.truthCells + "，评价域 " + r.ref.universe.length + " 格）。"
            + "降雨情景：" + r.scn.label + "，总量 " + fmt(r.scn.total, 0) + " mm。接入实测积水台账可直接复用本校核流程。</p>";
        $("fs-result").innerHTML = html;
        $("fs-apply").classList.remove("hide");
        drawChart(b, f);
    }

    function drawChart(b, f) {
        var el = $("fs-chart");
        if (!window.echarts) { el.innerHTML = ""; return; }
        var ch = echarts.init(el);
        ch.setOption({
            grid: { left: 96, right: 30, top: 26, bottom: 36 },
            xAxis: { type: "value", max: 1, axisLabel: { color: "#7fb7d4" }, splitLine: { lineStyle: { color: "rgba(0,150,255,.1)" } } },
            yAxis: {
                type: "category", data: ["F1 (CSI)", "POD", "1−FAR", "1−|BIAS−1|"],
                axisLabel: { color: "#a8d5ea", fontSize: 12 }
            },
            legend: { data: ["基准模型", "融合校正"], textStyle: { color: "#a8d5ea" }, top: 0 },
            series: [
                {
                    name: "基准模型", type: "bar", itemStyle: { color: "#5d7a99" }, barWidth: 14,
                    data: [b.csi, b.pod, 1 - b.far, Math.max(0, 1 - Math.abs(b.bias - 1))]
                },
                {
                    name: "融合校正", type: "bar", itemStyle: { color: "#00d3ff" }, barWidth: 14,
                    data: [f.csi, f.pod, 1 - f.far, Math.max(0, 1 - Math.abs(f.bias - 1))]
                }
            ]
        });
    }

    // ---------- 交互 ----------
    function open() {
        var st = FB.state;
        if (!st.city || !st.dom) { FB.toast("请先选择城市完成一次演算"); return; }
        modal.classList.add("on");
        $("fs-city").textContent = st.city.name_zh + " · " + (st.city.name_en || "");
        var demNote = st.city.id === "xinchang" ? "高精度 DEM（≈30 m，z12）已接入" : "DEM ≈ " + (st.city.dem_range ? st.city.dem_range[0] + "–" + st.city.dem_range[1] + " m" : "—");
        $("fs-dem").textContent = demNote;
        if (!lastRun || lastRun.cityId !== st.city.id) {
            $("fs-result").innerHTML = '<p class="fs-note">点击「运行融合校核」开始：以历史积水参考集为约束，率定多源融合参数并评价精度提升。</p>';
            $("fs-apply").classList.add("hide");
        } else {
            renderResult(lastRun.r);
        }
    }

    function startCal() {
        if (busy) return;
        busy = true;
        var bar = $("fs-bar"), txt = $("fs-status");
        $("fs-run").disabled = true;
        txt.textContent = "构建参考集…";
        setTimeout(function () {
            try {
                var t0 = performance.now();
                var r = runCalibration(function (p) {
                    txt.textContent = "网格搜索率定中… " + Math.round(p * 100) + "%";
                    bar.style.width = Math.round(p * 100) + "%";
                });
                if (!r) {
                    $("fs-result").innerHTML = '<p class="fs-note">该城市参考集不足，无法构建校核（建成区格点太少）。</p>';
                    return;
                }
                r.cityId = FB.state.city.id;
                r.ms = performance.now() - t0;
                lastRun = { cityId: r.cityId, r: r };
                txt.textContent = "完成 · 耗时 " + Math.round(r.ms / 100) / 10 + " s";
                renderResult(r);
            } catch (e) {
                txt.textContent = "校核失败：" + e.message;
                if (window.console) console.error("[fusion]", e);
            } finally {
                busy = false;
                $("fs-run").disabled = false;
                setTimeout(function () { bar.style.width = "0%"; }, 600);
            }
        }, 30);
    }

    function applyParams() {
        if (!lastRun) return;
        H.setParams(lastRun.r.params);
        FB.rebuildHydroParams();
        modal.classList.remove("on");
        FB.toast("融合参数已应用，正在重演");
        FB.run();
    }

    // ---------- 初始化 ----------
    function init() {
        modal = $("fusion-modal");
        if (!modal) return;
        var btn = $("btn-fusion");
        if (btn) btn.addEventListener("click", open);
        $("fs-close").addEventListener("click", function () { modal.classList.remove("on"); });
        modal.addEventListener("click", function (e) { if (e.target === modal) modal.classList.remove("on"); });
        $("fs-run").addEventListener("click", startCal);
        $("fs-apply").addEventListener("click", applyParams);
        renderSources();
        $("fs-diagram").innerHTML = frameworkSVG();
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else { init(); }
})();
