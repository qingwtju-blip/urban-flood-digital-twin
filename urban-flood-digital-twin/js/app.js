/* ============================================================
   城市内涝水动力过程数字孪生 · 应用层
   ============================================================ */
(function () {
    "use strict";
    var H = window.Hydro;
    var ML = window.FloodML;
    var $ = function (id) { return document.getElementById(id); };

    var state = {
        cities: [], city: null, geo: null, dem: null, dom: null,
        scnMode: "design", P: 100, dur: 3, eventIdx: 0, factor: 1,
        engine: "physics", algo: "gbdt", mlParams: {},
        layer: "depth", dispTh: 0.05, extent: "core",
        result: null, frameIdx: 0, playing: false, speed: 1,
        map: null, layerObj: null, geoLayer: null, zoneLayer: null,
        charts: {}, playheads: [], busy: false, cache: {},
    };

    var LEVEL_COLORS = ["#22c55e", "#ffd247", "#ff9820", "#ff6536", "#ff2b4d"];
    var LEVEL_NAMES = ["低风险", "中风险", "中高风险", "高风险", "极高风险"];

    // ============ 工具 ============
    function fmt(v, d) {
        if (v === null || v === undefined || isNaN(v)) return "—";
        return Number(v).toFixed(d === undefined ? 1 : d);
    }
    function toast(msg) {
        var t = $("toast"); t.textContent = msg; t.classList.add("on");
        clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove("on"); }, 1900);
    }
    // 未捕获异常只进控制台：界面上不要出现任何"报错"样式的浮层
    window.addEventListener("error", function (e) {
        if (window.console && console.error) console.error("[app]", e.message, e.filename, e.lineno);
    });
    function overlay(on, text, prog) {
        $("overlay").classList.toggle("on", !!on);
        if (text) $("ov-text").textContent = text;
        if (prog !== undefined) $("ov-bar").style.width = Math.round(prog * 100) + "%";
    }
    function levelIdx(r) {
        for (var i = H.RISK_LEVELS.length - 1; i >= 0; i--) if (r >= H.RISK_LEVELS[i].min) return i;
        return 4;
    }
    function levelColorByR(r) { return H.RISK_LEVELS[levelIdx(r)].color; }
    function levelNameByR(r) { return H.RISK_LEVELS[levelIdx(r)].name + "风险"; }

    // ============ 初始化 ============
    function parseHash() {
        var o = {};
        function eat(str) {
            (str || "").replace(/^[#?]/, "").split("&").forEach(function (kv) {
                if (!kv) return;
                var p = kv.split("=");
                if (p[0]) o[p[0]] = decodeURIComponent(p[1] === undefined ? "" : p[1]);
            });
        }
        eat(location.search);
        eat(location.hash);
        return o;
    }

    function init() {
        initClock();
        bindUI();
        initMap();
        var hs = parseHash();
        if (hs.p) state.P = +hs.p;
        if (hs.d) state.dur = +hs.d;
        if (hs.f) state.factor = +hs.f;
        if (hs.frame) state.jumpFrame = +hs.frame;
        if (hs.probe) state.probeHash = hs.probe;
        if (hs.engine) state.engine = hs.engine;
        if (hs.algo) state.algo = hs.algo;
        if (hs.scn) state.scnMode = hs.scn;
        fetch("data/cities.json?t=20261112b").then(function (r) { return r.json(); }).then(function (d) {
            state.cities = d.cities || d;
            buildCityGrid();
            var first = state.cities.find(function (c) { return c.id === hs.city; }) ||
                state.cities.find(function (c) { return c.id === "beijing"; }) ||
                state.cities.find(function (c) { return c.id === "shanghai"; }) || state.cities[0];
            selectCity(first.id);
        }).catch(function (e) {
            toast("城市清单加载失败：" + e.message);
        });
    }

    function initClock() {
        function tick() {
            var d = new Date();
            var p = function (n) { return n < 10 ? "0" + n : n; };
            $("clock").textContent = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
                p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
        }
        tick(); setInterval(tick, 1000);
    }

    // ============ 城市选择器（大区分组 + 搜索 + 最近访问）============
    var REGION_ORDER = ["华北", "东北", "华东", "华中", "华南", "西南", "西北"];
    // 与 tools/city_list.py 的 TIER_NAME 保持逐字一致（只用于 title 悬浮提示）
    var TIER_NAME = { 1: "一线", 2: "新一线", 3: "计划单列 / 强省会", 4: "典型补充", 9: "县级试点" };
    var RECENT_KEY = "hydrodt.recent";
    var cityQuery = "";

    // 拼音首字母，用于搜索（避免引入额外依赖）
    var PINYIN = {
        beijing: "bj", shanghai: "sh", guangzhou: "gz", shenzhen: "sz",
        chengdu: "cd", hangzhou: "hz", chongqing: "cq", wuhan: "wh",
        suzhou: "sz", xian: "xa", nanjing: "nj", changsha: "cs",
        tianjin: "tj", zhengzhou: "zz", dongguan: "dg", qingdao: "qd",
        kunming: "km", ningbo: "nb", hefei: "hf", xiamen: "xm",
        dalian: "dl", shenyang: "sy", jinan: "jn", fuzhou: "fz",
        wuxi: "wx", foshan: "fs", nanchang: "nc", guiyang: "gy",
        nanning: "nn", taiyuan: "ty", shijiazhuang: "sjz", haikou: "hk",
        lanzhou: "lz", yinchuan: "yc", urumqi: "wlmq", huhehaote: "hhht",
        changchun: "cc", haerbin: "heb", xining: "xn", lasa: "ls",
        xinchang: "xc"
    };

    function getRecent() {
        try {
            var a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function pushRecent(id) {
        var a = getRecent().filter(function (x) { return x !== id; });
        a.unshift(id);
        a = a.slice(0, 4);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(a)); } catch (e) { }
        renderRecent();
    }

    function cityMatch(c, q) {
        if (!q) return true;
        q = q.toLowerCase();
        if (c.name_zh.indexOf(q) >= 0) return true;
        if ((c.name_en || "").toLowerCase().indexOf(q) >= 0) return true;
        if ((c.province || "").indexOf(q) >= 0) return true;
        if ((PINYIN[c.id] || "").indexOf(q) === 0) return true;
        if ((c.id || "").indexOf(q) >= 0) return true;
        return false;
    }

    function buildCityGrid() {
        var box = $("city-groups");
        if (!box) return;
        var list = state.cities || [];
        // 按大区分组，组内按梯队再按原有顺序
        var groups = {};
        list.forEach(function (c) {
            var r = c.region || "其他";
            (groups[r] = groups[r] || []).push(c);
        });
        var order = REGION_ORDER.filter(function (r) { return groups[r]; });
        Object.keys(groups).forEach(function (r) {
            if (order.indexOf(r) < 0) order.push(r);
        });

        var html = order.map(function (r) {
            var arr = groups[r];
            var btns = arr.map(function (c) {
                var tier = TIER_NAME[c.tier] || "";
                return '<button data-id="' + c.id + '" title="' + c.name_zh + " · " + (c.province || "") +
                    (tier ? " · " + tier : "") + '">' + c.name_zh + "</button>";
            }).join("");
            // 默认展开「当前城市所在大区」，其余折叠
            var open = (state.city && state.city.region === r) || (!state.city && r === order[0]);
            return '<div class="cg' + (open ? " open" : "") + '" data-region="' + r + '">' +
                '<button class="cg-head" type="button">' +
                '<i class="cg-arrow"></i><span class="cg-name">' + r + "</span>" +
                '<span class="cg-num">' + arr.length + "</span></button>" +
                '<div class="cg-body"><div class="city-grid">' + btns + "</div></div></div>";
        }).join("");
        box.innerHTML = html;

        if (!box._bound) {
            box.addEventListener("click", function (e) {
                var head = e.target.closest(".cg-head");
                if (head) {
                    head.parentNode.classList.toggle("open");
                    return;
                }
                var b = e.target.closest("button[data-id]");
                if (b) selectCity(b.dataset.id);
            });
            box._bound = true;
        }
        updateCityCount();
        applyCityFilter();
    }

    function renderRecent() {
        var wrap = $("city-recent"), grid = $("city-recent-grid");
        if (!wrap || !grid) return;
        var ids = getRecent().filter(function (id) {
            return (state.cities || []).some(function (c) { return c.id === id; });
        });
        if (!ids.length) { wrap.classList.add("hide"); grid.innerHTML = ""; return; }
        wrap.classList.remove("hide");
        grid.innerHTML = ids.map(function (id) {
            var c = state.cities.find(function (x) { return x.id === id; });
            return '<button data-id="' + id + '" title="' + c.name_zh + '">' + c.name_zh + "</button>";
        }).join("");
        if (!grid._bound) {
            grid.addEventListener("click", function (e) {
                var b = e.target.closest("button[data-id]");
                if (b) selectCity(b.dataset.id);
            });
            grid._bound = true;
        }
        syncActive();
    }

    // 搜索：只隐藏不匹配项；命中时自动展开所在大区
    function applyCityFilter() {
        var q = cityQuery.trim();
        var box = $("city-groups");
        if (!box) return;
        var shown = 0;
        box.querySelectorAll(".cg").forEach(function (g) {
            var any = 0;
            g.querySelectorAll("button[data-id]").forEach(function (b) {
                var c = state.cities.find(function (x) { return x.id === b.dataset.id; });
                var ok = c && cityMatch(c, q);
                b.classList.toggle("hide", !ok);
                if (ok) any++;
            });
            g.classList.toggle("hide", any === 0);
            if (q) g.classList.toggle("open", any > 0);
            shown += any;
        });
        // 搜索无结果时给个提示
        var emptyEl = box.querySelector(".cg-empty");
        if (q && shown === 0) {
            if (!emptyEl) {
                emptyEl = document.createElement("p");
                emptyEl.className = "cg-empty tip";
                emptyEl.style.cssText = "margin:10px 2px;font-size:11px;color:var(--txt3)";
                box.appendChild(emptyEl);
            }
            emptyEl.textContent = "未匹配到「" + q + "」";
        } else if (emptyEl) {
            emptyEl.remove();
        }
        updateCityCount(shown);
    }

    function updateCityCount(shown) {
        var el = $("city-count");
        if (!el) return;
        var total = (state.cities || []).length;
        el.textContent = (shown === undefined || shown === total) ? (total + " 城") : (shown + "/" + total);
    }

    function syncActive() {
        var cur = state.city ? state.city.id : null;
        document.querySelectorAll("#city-groups button[data-id], #city-recent-grid button[data-id]")
            .forEach(function (b) {
                b.classList.toggle("on", b.dataset.id === cur);
            });
    }

    // ============ 边界/地形加载 ============
    // 切城/改参后回到"待演算"空态：清结果、清图层、指标归零
    function resetToIdle() {
        state.result = null;
        state.frameIdx = 0;
        state.probeCell = null;
        var pb = $("probe"); if (pb) pb.classList.add("hide");
        // 「地形」是纯数据图层，不依赖演算结果 —— 清空结果时不该把它一起拆掉，
        // 否则用户切到城市后地形图直接消失、只剩卫星照（之前的观感问题）。
        // 出结果图层（水深/风险/最大淹没）与积水点标记才需要清除。
        if (state.layer !== "terrain") {
            if (state.layerObj) { try { state.map.removeLayer(state.layerObj); } catch (e) { } state.layerObj = null; }
        }
        if (state.zoneLayer) { try { state.map.removeLayer(state.zoneLayer); } catch (e) { } state.zoneLayer = null; }
        ["s-t", "s-rain", "s-area", "s-max"].forEach(function (k) {
            var el = $(k);
            if (el) { el.textContent = k === "s-t" ? "0.0 h" : "—"; }
        });
        var te = $("tl-time"); if (te) te.textContent = "T + 0.0 h";
        var tp = $("tl-peak"); if (tp) tp.textContent = "峰 —";
        ["tl-rain", "tl-area", "tl-marks"].forEach(function (k) {
            var el = $(k); if (el) el.innerHTML = "";
        });
        $("tl-range").value = 0;
        renderAcc(null);
        if (typeof renderCalLog === "function") renderCalLog();
        var zl = $("zone-list");
        if (zl) zl.innerHTML = '<p class="empty">尚未演算 · 点「开始演算」后列出积水点</p>';
        var kp = $("kpi");
        if (kp) kp.innerHTML = "";
        updateLegend();
    }

    // 主城区计算域边长（km）：按「建成区规模」自适应
    // ------------------------------------------------------------
    // 旧版用市域面积算 1.15·sqrt(area) 再夹到 [28,60]，对辖县多的城市完全失真：
    //   · 南宁市域 22112 km²（含大片山地农田）→ 算出 171 km，夹到 60；
    //   · 重庆市域 82400 km² → 算出 330 km，夹到 60；
    //   · 结果几乎所有大城市都顶在 60 km 上，尺度差别被抹平，
    //     而深圳（市域 1997）只有 51 km —— 顺序反而是反的。
    // 现在改用建成区面积 built_km2（住建部城区口径）：
    //   · 边长 = 1.6·sqrt(建成区面积)，夹到 [26, 68]
    //   · 上海 1238 → 56 km，北京 1469 → 61 km，重庆 1568 → 63 km
    //   · 拉萨 100 → 26 km，新昌 38 → 26 km
    // 320 网格下每格 81~213 m，既覆盖整片城区，又保留街道级分辨率。
    // 后端 tools/city_list.py 的 core_km_of() 用的是同一公式，改这里要同步。
    function coreSizeKm(city) {
        var b = +(city && city.built_km2) || 0;
        var a = +(city && city.area_km2) || 5000;
        if (b <= 0) b = Math.max(30, a * 0.12);   // 老数据没有 built_km2 时兜底
        var v = 1.6 * Math.sqrt(b);
        if (v < 26) v = 26;
        if (v > 68) v = 68;
        return Math.round(v);
    }

    // extent 按钮文案跟随当前城市的自适应边长：主城区 47km / 全市域
    function syncExtentLabel() {
        var box = $("extent-toggle");
        if (!box) return;
        var btns = box.querySelectorAll("button");
        if (btns[0] && state.city) {
            btns[0].textContent = "主城区 " + coreSizeKm(state.city) + "km";
        }
    }

    function selectCity(id) {
        var city = state.cities.find(function (c) { return c.id === id; });
        if (!city) return;
        state.city = city;
        syncActive();
        pushRecent(id);
        syncExtentLabel();
        // 让当前城市所在的大区展开并滚动到可见位置
        var g = document.querySelector('#city-groups .cg[data-region="' + (city.region || "") + '"]');
        if (g) {
            g.classList.add("open");
            if (g.scrollIntoView) { try { g.scrollIntoView({ block: "nearest" }); } catch (e) { } }
        }
        overlay(true, "正在加载 " + city.name_zh + " 行政边界与地形…", 0.1);
        // 数据版本号：DEM 存储格式在 2026-11-12 从「int16 绝对高程」改为
        // 「uint16 相对 z0 偏移」，旧缓存按新格式解码会读出错误高程，
        // 因此所有数据请求都带上版本号强制刷新。
        var DV = "?t=20261112b";
        var key = "geo:" + id;
        var pGeo = state.cache[key] ? Promise.resolve(state.cache[key]) :
            fetch("data/geo/" + id + ".json" + DV).then(function (r) { return r.json(); });
        // DEM 分两套：主城区视图读 <id>_core.json（按建成区自适应的 26~68 km 窗），
        // 全市域视图读 <id>.json（全境概览）。老城市没有 _core 时自动回退。
        var wantCore = (state.extent === "core") && city.has_core_dem !== false;
        var demName = wantCore ? (id + "_core") : id;
        var key2 = "dem:" + demName;
        var pDem = state.cache[key2] ? Promise.resolve(state.cache[key2]) :
            fetch("data/dem/" + demName + ".json" + DV).then(function (r) {
                if (!r.ok && wantCore) {
                    // 回退到全境 DEM，保证任何城市都能演算
                    return fetch("data/dem/" + id + ".json" + DV).then(function (r2) { return r2.json(); });
                }
                return r.json();
            });
        overlay(true, "正在加载数据…", 0.4);
        Promise.all([pGeo, pDem]).then(function (arr) {
            state.geo = arr[0]; state.dem = arr[1];
            state.cache[key] = arr[0]; state.cache[key2] = arr[1];
            overlay(true, "正在构建计算域…", 0.7);
            return new Promise(function (res) { setTimeout(res, 30); });
        }).then(function () {
            var t0 = performance.now();
            var opt = { n: 320 };
            var coreKm = coreSizeKm(city);
            if (state.extent === "core") opt.sizeKm = coreKm;
            state.dom = H.buildDomain(city, state.geo, state.dem, opt);
            state.domMs = performance.now() - t0;
            // 换城市必须重建栅格图层：DepthLayer 里绑着上一个城市的 dom（网格、bbox、
            // DEM 缓存），不销毁就会出现"点了没反应 / 还是旧城市的水面"。
            if (state.layerObj) { try { state.map.removeLayer(state.layerObj); } catch (e) { } state.layerObj = null; }
            if (state.zoneLayer) { try { state.map.removeLayer(state.zoneLayer); } catch (e) { } state.zoneLayer = null; }
            state.probeCell = null;
            $("probe").classList.add("hide");
            state.result = null;
            buildPchips(); buildDchips(); buildEventList();
            renderRainBox();
            fitMap();
            overlay(false);
            var aKm2 = 0;
            for (var i = 0; i < state.dom.N; i++) if (state.dom.mask[i]) aKm2 += state.dom.cellArea / 1e6;
            $("meta-domain").textContent = (state.extent === "core" ? "主城区 " : "全市域 ") + fmt(aKm2, 0) + " km²";
            $("meta-res").textContent = fmt(state.dom.dx, 0) + " m";
            $("map-caption").textContent = city.name_zh + " · " + (state.extent === "core" ? "主城区 " + fmt(coreKm, 0) + "×" + fmt(coreKm, 0) + " km" : "全市域 " + fmt(city.area_km2, 0) + " km²") +
                " · 网格 " + state.dom.n + "×" + state.dom.n + "（" + fmt(state.dom.dx, 0) + " m）";
            // 城市只是"切换"：加载边界与地形、重建计算域，但不自动演算
            resetToIdle();
            // 地形图层闭包着上一座城市的 dom（网格/bbox/DEM），换城市必须重建成，
            // 不能复用；此时结果为空，refreshLayer 里对 terrain 有单独放行逻辑。
            if (state.layer === "terrain") refreshLayer();
            markDirty();
            showFreshHint(city.name_zh + " 地形与边界已加载 · 点击「开始演算」生成积水过程");
        }).catch(function (e) {
            overlay(false);
            toast("数据加载失败：" + e.message);
            console.error(e);
        });
    }

    // ============ 地图 ============
    // ---------- 底图：高德卫星影像（国内直连、免 key）----------
    // Google 瓦片本机直连不通；天地图卫星需要注册 tk。
    // 高德卫星（style=6）+ 透明路网注记（style=8）叠起来就是
    // Google 混合图的效果，国内直连可用、无需任何 key。
    var BASEMAPS = [
        {
            id: "amap", name: "卫星影像", maxZoom: 18, sat: true,
            url: "https://webst{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
            subdomains: ["01", "02", "03", "04"],
            attr: "高德地图"
        },
        { id: "local", name: "本地DEM", maxZoom: 19, url: null, attr: "本地计算域 DEM（离线兜底）" }
    ];
    function basemapById(id) {
        for (var bi = 0; bi < BASEMAPS.length; bi++) if (BASEMAPS[bi].id === id) return BASEMAPS[bi];
        return BASEMAPS[0];
    }

    // 底图图层只创建一次，之后只在"显示/隐藏"之间切换。
    // 之前每次 setBasemap 都 removeLayer + new tileLayer，图层对象和 DOM 里的
    // 真正容器会脱节（state.baseLayer._tiles 为 0，页面上却有一堆无主瓦片），
    // 表现为底图整片不显示。
    var AMAP_SAT = "https://webst{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}";
    var AMAP_ANN = "https://webst{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}";
    var AMAP_OPT = {
        subdomains: ["01", "02", "03", "04"],
        minZoom: 2, maxNativeZoom: 18, maxZoom: 19, keepBuffer: 4
    };

    // 切换底图：只改图层的显隐 / 本地 DEM 开关，不动已算好的演算结果
    function setBasemap(id) {
        var src = basemapById(id);
        state.basemap = src.id;
        if (!state.map) return;

        if (!state.baseLayer) {
            state.baseLayer = L.tileLayer(AMAP_SAT, AMAP_OPT);
            state.annLayer = L.tileLayer(AMAP_ANN, L.Util.extend({ opacity: 0.95 }, AMAP_OPT));
            // 底图连续失败（断网）时静默退回本地 DEM，不弹任何红色提示
            state.baseLayer.on("tileerror", function () {
                state.tileErrs = (state.tileErrs || 0) + 1;
                if (state.tileErrs === 14 && state.basemap !== "local") setBasemap("local");
            });
        }

        var loc = (src.id === "local");
        if (loc) {
            if (state.map.hasLayer(state.baseLayer)) state.map.removeLayer(state.baseLayer);
            if (state.map.hasLayer(state.annLayer)) state.map.removeLayer(state.annLayer);
        } else {
            if (!state.map.hasLayer(state.baseLayer)) {
                state.baseLayer.addTo(state.map);
                state.baseLayer.setZIndex(1);
            }
            // 卫星影像上叠一层透明路网+注记，等效 Google 混合图
            if (!state.map.hasLayer(state.annLayer)) {
                state.annLayer.addTo(state.map);
                state.annLayer.setZIndex(2);
            }
        }

        if (state.layerObj) {
            state.layerObj._useLocal = loc;
            state.layerObj._raster = null;
            if (state.layerObj._map) state.layerObj._reset();
        }
        updateLegend();
    }

    function initMap() {
        state.map = L.map("map", {
            zoomControl: true, attributionControl: false, preferCanvas: true,
            zoomSnap: 0.25, minZoom: 2, worldCopyJump: true,
            // 关掉瓦片淡入：无头截图时 requestAnimationFrame 不推进，
            // 瓦片会一直停在 opacity:0，截出来的地图是黑的
            fadeAnimation: false,
        }).setView([31.2, 121.5], 9);
        // 底图是高德卫星影像+路网注记：拖到世界任何地方都有地图，
        // 计算域只决定"淹没图层"的范围，不再由它决定底图有没有东西。
        setTimeout(function () { state.map.invalidateSize(); }, 200);
        state.basemap = state.basemap || "amap";
        setBasemap(state.basemap);
        // 布局首个动画帧里 grid 可能还没算出高度（实测只有 126×210），
        // fitBounds 会按这个错误尺寸算缩放级别 → 整个计算域缩成一小块，
        // 换城市也看不出变化。用 ResizeObserver 等尺寸真正定型再重新定视野。
        var box = document.getElementById("map");
        if (window.ResizeObserver && box) {
            var lw = 0, lh = 0;
            var ro = new ResizeObserver(function () {
                if (!state.map) return;
                var s = state.map.getSize();
                if (Math.abs(s.x - lw) < 6 && Math.abs(s.y - lh) < 6) return;
                lw = s.x; lh = s.y;
                state.map.invalidateSize();
                if (!state.dom) return;
                if (state.viewMode === "pond") fitPonds(); else fitMap();
            });
            ro.observe(box);
        }
    }

    function fitMap() {
        if (!state.geo) return;
        var b = (state.dom && state.dom.bbox) ? state.dom.bbox : state.city.bbox_real;
        state.map.invalidateSize();
        var sz = state.map.getSize();
        if (sz.x < 220 || sz.y < 160) {          // 容器还没定型，等 ResizeObserver 再来
            setTimeout(function () { if (state.dom) fitMap(); }, 120);
            return;
        }
        state.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [18, 18], animate: false });
        drawBoundary();
        setTimeout(function () {
            state.map.invalidateSize();
            state.map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [18, 18], animate: false });
        }, 260);
    }

    // 同步"视野"按钮状态（自动回退到全域时不要出现按钮与实际视野不符）
    function setViewMode(v) {
        state.viewMode = v;
        var box = $("view-tabs"); if (!box) return;
        box.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === v); });
    }

    // 视野聚焦到主要积水区：取面积×水深最大的 6 处内涝点作外包框，
    // 否则 40 km 全域里几平方公里的水面只有几十个像素，看不清范围
    function fitPonds() {
        var r = state.result;
        if (!r || !r.zones || !r.zones.length) { fitMap(); return; }
        var la0 = 90, la1 = -90, lo0 = 180, lo1 = -180, hit = 0;
        r.zones.slice(0, 6).forEach(function (z) {
            if (z.maxDepth < 0.15) return;
            hit++;
            if (z.lat < la0) la0 = z.lat; if (z.lat > la1) la1 = z.lat;
            if (z.lon < lo0) lo0 = z.lon; if (z.lon > lo1) lo1 = z.lon;
        });
        if (!hit) { setViewMode("all"); fitMap(); return; }
        // 积水点分散在全域时不要硬拉近，否则会出现莫名其妙的"半城视野"
        var b = state.dom.bbox;
        if ((la1 - la0) > (b[3] - b[1]) * 0.66 || (lo1 - lo0) > (b[2] - b[0]) * 0.66) { setViewMode("all"); fitMap(); return; }
        var pa = Math.max(0.012, (la1 - la0) * 0.12), po = Math.max(0.012, (lo1 - lo0) * 0.12);
        setViewMode("pond");
        state.map.fitBounds([[la0 - pa, lo0 - po], [la1 + pa, lo1 + po]], { padding: [40, 40], animate: false });
    }

    function drawBoundary() {
        if (state.geoLayer) { state.map.removeLayer(state.geoLayer); state.geoLayer = null; }
        var g = L.layerGroup();
        // 区县界
        (state.geo.districts || []).forEach(function (d) {
            d.rings.forEach(function (ring) {
                L.polyline(ring.map(function (p) { return [p[1], p[0]]; }), {
                    color: "#5c8ba1", weight: 0.8, opacity: 0.45, dashArray: "3,5", interactive: false,
                }).addTo(g);
            });
        });
        // 主轮廓
        state.geo.rings.forEach(function (ring) {
            L.polygon(ring.map(function (p) { return [p[1], p[0]]; }), {
                color: "#0b5f7a", weight: 2, opacity: 0.95, fill: false, className: "cty-bound", interactive: false,
            }).addTo(g);
        });
        // 遮罩：城市外区域压暗
        var outer = [[[-85, -180], [-85, 180], [85, 180], [85, -180]]];
        var hole = state.geo.rings.map(function (ring) { return ring.map(function (p) { return [p[1], p[0]]; }); });
        L.polygon([outer[0]].concat(hole), {
            color: "none", fillColor: "#0a1622", fillOpacity: 0.16, interactive: false,
        }).addTo(g);
        g.addTo(state.map);
        state.geoLayer = g;
    }

    // ---------- 水深栅格图层 ----------
    var DepthLayer = L.Layer.extend({
        initialize: function (dom) {
            this._dom = dom;
            this._raster = null;
            this._mode = "depth";
            this._field = null;
        },
        onAdd: function (map) {
            this._map = map;
            this._canvas = L.DomUtil.create("canvas", "leaflet-depth-layer");
            this._canvas.style.position = "absolute";
            this._canvas.style.pointerEvents = "none";
            map.getPanes().overlayPane.appendChild(this._canvas);
            map.on("moveend zoomend resize viewreset", this._reset, this);
            this._reset();
        },
        onRemove: function (map) {
            if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
            map.off("moveend zoomend resize viewreset", this._reset, this);
        },
        setField: function (field, mode) {
            this._field = field;
            if (mode) this._mode = mode;
            this._raster = null;
            if (this._map) this._reset();
        },
        setMode: function (mode) {
            this._mode = mode;
            this._raster = null;
            if (this._map) this._reset();
        },
        _makeRaster: function () {
            var dom = this._dom, n = dom.n;
            var f = this._field, mode = this._mode;
            var risk = this._risk;
            var th = this._th || 0.05;
            // 超采样：把 200m 级网格用双线性插值放大 2~3 倍再按色阶二分类，
            // 得到「边界平滑、色块硬边」的淹没范围（不是高斯羽化的模糊糊一片）
            //
            // 【2026-11-12 提高清晰度】原来上限是 1080，而网格只有 320 格，
            // 一个网格要摊成 3.4 个屏幕像素 —— 色阶呈台阶块状，这是"糊"的主因。
            // 地形图层没有色阶二分类的需求，纯粹是被插值放大，提到 1600 后
            // 每网格 5 像素，双线性 + 山体阴影的过渡就顺了；同时让浏览器按
            // 平滑方式拉伸（image-rendering:auto），避免放大时出现硬边马赛克。
            var isTerrainMode = (mode === "terrain");
            var cap = isTerrainMode ? 1600 : 1080;
            var S = (this._cellPx && this._cellPx < 3.2) ? 3 : 2;
            if (isTerrainMode && n * S < 1200) S = 4;
            var W = Math.min(cap, n * S), Hh = W;
            var cv = document.createElement("canvas");
            cv.width = W; cv.height = Hh;
            var ctx = cv.getContext("2d");
            var img = ctx.createImageData(W, Hh);
            var d = img.data;
            var mask = dom.mask, water = dom.water, z = dom.z;
            var zmin = this._zmin, zspan = Math.max(1, this._zmax - this._zmin);
            var pal = DEPTH_CLASSES;
            // 底图默认由在线卫星瓦片提供（见 BASEMAPS），水深/风险层只画叠色、其余透明。
            //
            // 【2026-11-12 修正】原来的逻辑是「只有底图被切成 local 时才画高程底色」，
            // 而 local 只在卫星瓦片连续失败 14 次后才会被动触发。结果是：用户点「地形」
            // 标签，看到的一直是卫星影像，本地 DEM 的色阶/山体阴影根本没上屏 —— 这就是
            // 之前觉得"DEM 底图不清楚"的真正原因，而不是数据分辨率不够。
            // 现在：地形图层始终使用本地 DEM 渲染（它是专题图，不该让卫星照片透上来）。
            var useLocal = !!this._useLocal;
            var isTerrain = (mode === "terrain");
            var useBase = useLocal || isTerrain;

            if (useBase && (!this._base || this._baseN !== n || this._baseDom !== dom)) {
                var tn = new Float32Array(n * n), sh = new Float32Array(n * n);
                var un = dom.urban || new Float32Array(n * n);
                var wf = new Float32Array(n * n), wfRaw = new Float32Array(n * n);
                // 水体裁剪：演算用的 water 掩膜取「汇流量前 6%」，把山坡上的小冲沟
                // 也算成了河，直接画出来就是满图蓝色碎点。显示阶段先做一遍
                // 连通域筛选：只保留面积 >= 6 格的水体，孤立碎点丢掉。
                var wsrc0 = water;
                var seen = new Uint8Array(n * n);
                var stack = new Int32Array(n * n);
                var keep = new Uint8Array(n * n);
                var MINW = 6;                                   // 最小水体面积（格）
                for (var c0 = 0; c0 < n * n; c0++) {
                    if (!wsrc0[c0] || seen[c0]) continue;
                    var sp = 0, tot = 0;
                    stack[sp++] = c0; seen[c0] = 1;
                    var members = [];
                    while (sp > 0) {
                        var cur = stack[--sp];
                        members.push(cur); tot++;
                        var cx = cur % n, cy = (cur - cx) / n;
                        for (var d4 = 0; d4 < 4; d4++) {
                            var nx2 = cx + NB4I[d4], ny2 = cy + NB4J[d4];
                            if (nx2 < 0 || nx2 >= n || ny2 < 0 || ny2 >= n) continue;
                            var nb = ny2 * n + nx2;
                            if (wsrc0[nb] && !seen[nb]) { seen[nb] = 1; stack[sp++] = nb; }
                        }
                    }
                    if (tot >= MINW) for (var mm = 0; mm < members.length; mm++) keep[members[mm]] = 1;
                }
                for (var q1 = 0; q1 < n * n; q1++) wfRaw[q1] = keep[q1] ? 1 : 0;
                // 再做两遍 3×3 均值：单遍时 1 格宽的窄河只被软化到 0.1~0.2 的比重，
                // 落到地形图上仍是碎点；两遍后窄河被摊开到足够比重，河岸也不再是锯齿台阶。
                for (var pass = 0; pass < 2; pass++) {
                    var wsrc = pass === 0 ? wfRaw : wf;
                    var wout = (pass === 0) ? wf : new Float32Array(n * n);
                    for (var qj = 0; qj < n; qj++) {
                        for (var qi = 0; qi < n; qi++) {
                            var accW = 0, cntW = 0;
                            for (var dj = -1; dj <= 1; dj++) {
                                for (var di = -1; di <= 1; di++) {
                                    var wi = qi + di, wj = qj + dj;
                                    if (wi < 0 || wi >= n || wj < 0 || wj >= n) continue;
                                    accW += wsrc[wj * n + wi]; cntW++;
                                }
                            }
                            wout[qj * n + qi] = accW / Math.max(1, cntW);
                        }
                    }
                    wf = wout;
                }
                var zsmp = [];
                for (var q0 = 0; q0 < n * n; q0 += 3) if (mask[q0]) zsmp.push(z[q0]);
                zsmp.sort(function (a, b) { return a - b; });
                var p2 = zsmp.length ? zsmp[Math.floor(zsmp.length * 0.02)] : zmin;
                var p98 = zsmp.length ? zsmp[Math.floor(zsmp.length * 0.98)] : zmin + 100;
                // 【2026-11-12】归一化按地形起伏分两档，解决"平原城市糊成一片"：
                //   山地/丘陵（高差 > 120 m）—— 2%~98% 分位拉伸，层次最饱满
                //   平原（高差 <= 120 m）—— 若同样拉满量程，上海这种 100 m 高差的
                //   城市会把百来米的微小起伏涂成满屏黄绿、看不出任何结构。
                //   改为把它映射到色阶的**低段**（0 ~ 0.45），低洼偏青绿、微高偏草绿，
                //   平地就该看着平；山脊绝不出现，避免制造虚假地形。
                var relief = p98 - p2;
                var tZ = 1.0;                                    // 色阶可用上界
                if (relief < 120) {
                    tZ = 0.45;                                   // 平原：只占低段
                    // 把真实高差拉伸到 0~tZ，保留相对起伏但整体偏"平"
                    p98 = p2 + relief / tZ;
                }
                if (p98 - p2 < 25) p98 = p2 + 25;          // 极平坦城市保底
                // 归一化用的高程跨度（米），阴影换算真实坡度时要用回它
                var zminT = p2, zmaxT = p98;
                for (var tj = 0; tj < n; tj++) {
                    for (var ti = 0; ti < n; ti++) {
                        var tk2 = tj * n + ti;
                        var tz0 = Math.max(0, Math.min(1, (z[tk2] - p2) / (p98 - p2)));
                        tn[tk2] = Math.pow(tz0, 1.02);
                    }
                }

                // 山体阴影：对"归一化高程"求梯度，再按本城起伏的 85% 分位自适应放大。
                // 直接拿米做梯度的话，平原城市（20~60 m）没有立体感、山地城市黑成一片。
                //
                // 【2026-11-12 修正条纹】原来直接在 320 网格上求梯度，而屏幕上每格已
                // 放大到 4~5 像素；网格级梯度被双线性铺开后，沿坡面方向会形成一条条
                // 平行色带（重庆这种密集山地尤其明显，看着像"拉花"而不是地形）。
                // 做法：先对 tn 做两遍 3×3 平滑（保留山脊/河谷这类大尺度起伏，压掉
                // 单格台阶），再求梯度；阴影只是明暗调制，不该承担刻画细节的职责。
                var tsm = tn;
                for (var sp = 0; sp < 2; sp++) {
                    var tnext = new Float32Array(n * n);
                    for (var sj2 = 0; sj2 < n; sj2++) {
                        for (var si2 = 0; si2 < n; si2++) {
                            var sk2 = sj2 * n + si2;
                            var acc2 = tn[sk2] * 4, cnt2 = 4;
                            for (var sd2 = 0; sd2 < 4; sd2++) {
                                var ti3 = si2 + NB4I[sd2], tj3 = sj2 + NB4J[sd2];
                                if (ti3 < 0 || ti3 >= n || tj3 < 0 || tj3 >= n) continue;
                                acc2 += tn[tj3 * n + ti3]; cnt2++;
                            }
                            tnext[sk2] = acc2 / cnt2;
                        }
                    }
                    tsm = tnext;
                }
                var gxA = new Float32Array(n * n), gyA = new Float32Array(n * n);
                for (var gj = 0; gj < n; gj++) {
                    for (var gi = 0; gi < n; gi++) {
                        var gk = gj * n + gi;
                        var lf = gi > 0 ? tsm[gk - 1] : tsm[gk], rt = gi < n - 1 ? tsm[gk + 1] : tsm[gk];
                        var up = gj > 0 ? tsm[gk - n] : tsm[gk], dn = gj < n - 1 ? tsm[gk + n] : tsm[gk];
                        gxA[gk] = (rt - lf) * 0.5;
                        gyA[gk] = (dn - up) * 0.5;      // 行号增大 = 向北
                    }
                }
                // 标准坡向光照（Hillshade）：把梯度换算成"每米高差"，得到真实坡度角，
                // 再按方位角 315°、高度角 45° 求兰伯特余弦。
                //
                // 【2026-11-12 重写】原公式把"归一化高程梯度"直接当斜率塞进
                //   nl = sqrt(qx²+qy²+1)、s0 = (0.5qx - 0.5qy + 0.7071)/nl
                // 里，单位不成立：qz 恒等 1 而 qx/qy 是 0.x 量级，s0 只落在
                // 0.60~0.78 的窄带里 —— 阴影几乎看不出起伏，真正主导明暗的反而是
                // 双线性插值在像素级产生的差分，于是沿坡向出现一条条平行条纹。
                // 改用坡度角模型后阴影幅度由真实地形决定，条纹自然消失。
                var cellM = dom.dx || 200;                    // 网格实际边长（米）
                var zr = Math.max(1, zmaxT - zminT);          // 归一化用的高程跨度（米）
                var LSQ = 1.0, LSX = -0.7071, LSY = 0.7071;   // 光向量（西北 45°，已归一）
                for (var hj = 0; hj < n; hj++) {
                    for (var hi = 0; hi < n; hi++) {
                        var hk = hj * n + hi;
                        // 归一化梯度 -> 米制梯度（z/米）
                        var sx = gxA[hk] * zr / cellM;
                        var sy = gyA[hk] * zr / cellM;
                        var inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
                        var s0 = (LSX * sx + LSY * sy + LSQ) * inv;
                        sh[hk] = s0 < 0 ? 0 : (s0 > 1 ? 1 : s0);
                    }
                }
                this._base = { tn: tn, sh: sh, un: un, wf: wf, p2: p2, p98: p98 };
                this._baseN = n;
                this._baseDom = dom;
            }
            var tnA = null, shA = null, unA = null, wfA = null;
            if (useBase) {
                tnA = this._base.tn; shA = this._base.sh; unA = this._base.un; wfA = this._base.wf;
            }

            // 显示前的轻量平滑（仅渲染用）：把栅格上的 45° 锯齿磨圆，
            // 再按色阶硬分类，边界既圆润又清楚，不是高斯模糊
            if (f && (mode === "depth" || mode === "maxd")) {
                var sm = new Float32Array(n * n);
                for (var sj = 0; sj < n; sj++) {
                    for (var si = 0; si < n; si++) {
                        var sk = sj * n + si;
                        var acc0 = 4 * f[sk], wsum = 4;
                        for (var sd = 0; sd < 4; sd++) {
                            var ti2 = si + NB4I[sd], tj2 = sj + NB4J[sd];
                            if (ti2 < 0 || ti2 >= n || tj2 < 0 || tj2 >= n) continue;
                            var tk = tj2 * n + ti2;
                            if (!mask[tk]) continue;
                            acc0 += f[tk]; wsum++;
                        }
                        sm[sk] = acc0 / wsum;
                    }
                }
                f = sm;
            }

            for (var j = 0; j < Hh; j++) {
                var row = Hh - 1 - j;                       // f 行 0 在南，图像第 0 行在北
                var gy = (j + 0.5) / Hh * n - 0.5;
                var y0 = Math.floor(gy), ty = gy - y0;
                if (y0 < 0) { y0 = 0; ty = 0; } else if (y0 > n - 2) { y0 = n - 2; ty = 1; }
                var rc = row * W;
                for (var i = 0; i < W; i++) {
                    var o = (rc + i) * 4;
                    var gx = (i + 0.5) / W * n - 0.5;
                    var x0 = Math.floor(gx), tx = gx - x0;
                    if (x0 < 0) { x0 = 0; tx = 0; } else if (x0 > n - 2) { x0 = n - 2; tx = 1; }
                    // 用最近格点判定是否在城市内，保证边界不向外"晕开"
                    var kc = Math.round(gy) * n + Math.round(gx);
                    if (!mask[kc]) { d[o + 3] = 0; continue; }

                    var k00 = y0 * n + x0;
                    var bR = 0, bG = 0, bB = 0;
                    if (useBase) {
                        var tB = (tnA[k00] * (1 - tx) + tnA[k00 + 1] * tx) * (1 - ty) +
                            (tnA[k00 + n] * (1 - tx) + tnA[k00 + n + 1] * tx) * ty;
                        var sB = (shA[k00] * (1 - tx) + shA[k00 + 1] * tx) * (1 - ty) +
                            (shA[k00 + n] * (1 - tx) + shA[k00 + n + 1] * tx) * ty;
                        var uB = (unA[k00] * (1 - tx) + unA[k00 + 1] * tx) * (1 - ty) +
                            (unA[k00 + n] * (1 - tx) + unA[k00 + n + 1] * tx) * ty;
                        var cb = terrainRamp(tB);
                        // 山体阴影：明暗幅度要收着用。地形信息靠色阶 + 河网表达，
                        // 阴影只负责"让山立起来"；给太强会把插值台阶放大成条带伪影。
                        var br = isTerrainMode
                            ? 0.70 + 0.42 * sB
                            : 0.72 + 0.40 * sB;
                        bR = cb[0] * br; bG = cb[1] * br; bB = cb[2] * br;
                        var wu = Math.min(0.22, Math.max(0, uB - 0.55) * 0.55);
                        if (wu > 0) {
                            bR = bR * (1 - wu) + 202 * wu;
                            bG = bG * (1 - wu) + 199 * wu;
                            bB = bB * (1 - wu) + 192 * wu;
                        }
                        // 河湖：按双线性水体比重软化边界，避免一格一格的阶梯状河岸。
                        // 地形专题图上加深并提高不透明度上限，让长江/嘉陵江这类
                        // 主干河道成为清晰的地貌骨架（原来 0.9 上限基本是实色，但基色偏灰）
                        var wB2 = (wfA[k00] * (1 - tx) + wfA[k00 + 1] * tx) * (1 - ty) +
                            (wfA[k00 + n] * (1 - tx) + wfA[k00 + n + 1] * tx) * ty;
                        if (wB2 > 0.25) {
                            var wa = Math.min(0.92, (wB2 - 0.25) / 0.40);
                            if (isTerrainMode) {
                                // 水体也吃一点阴影，否则河道像贴上去的一层蓝纸
                                var wsh = 0.85 + 0.20 * sB;
                                bR = bR * (1 - wa) + 74 * wsh * wa;
                                bG = bG * (1 - wa) + 128 * wsh * wa;
                                bB = bB * (1 - wa) + 168 * wsh * wa;
                            } else {
                                bR = bR * (1 - wa) + 104 * wa;
                                bG = bG * (1 - wa) + 152 * wa;
                                bB = bB * (1 - wa) + 178 * wa;
                            }
                        }
                    }

                    if (mode === "terrain") {
                        // 地形专题图：永远铺本地 DEM 色阶 + 山体阴影
                        d[o] = bR; d[o + 1] = bG; d[o + 2] = bB; d[o + 3] = 255;
                        continue;
                    }
                    if (mode === "risk") {
                        var li = (risk && risk[kc] >= 0) ? risk[kc] : 4;
                        var rgb = hex2rgb(LEVEL_COLORS[4 - li]);
                        if (useLocal) {
                            var ra = (li === 4 ? 0.12 : 0.55);
                            d[o] = bR * (1 - ra) + rgb[0] * ra;
                            d[o + 1] = bG * (1 - ra) + rgb[1] * ra;
                            d[o + 2] = bB * (1 - ra) + rgb[2] * ra;
                            d[o + 3] = 255;
                        } else {
                            d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2];
                            d[o + 3] = li === 4 ? 24 : 140;
                        }
                        continue;
                    }
                    // ---- 水深 ----
                    if (!f) {
                        // 演算前没有水深场：铺一层淡淡的地形底色做参照，
                        // 比透出卫星照再叠色块更容易看清网格与汇流方向
                        if (useLocal) { d[o] = bR; d[o + 1] = bG; d[o + 2] = bB; d[o + 3] = 255; }
                        continue;
                    }
                    var v00 = f[k00], v10 = f[k00 + 1], v01 = f[k00 + n], v11 = f[k00 + n + 1];
                    var v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
                    var ci = v >= th ? depthClass(v) : -1;
                    if (ci < 0) {
                        if (useLocal) { d[o] = bR; d[o + 1] = bG; d[o + 2] = bB; d[o + 3] = 255; }
                        continue;
                    }
                    var pc = pal[ci];
                    if (useLocal) {
                        var a = pc.a / 255;
                        d[o] = bR * (1 - a) + pc.rgb[0] * a;
                        d[o + 1] = bG * (1 - a) + pc.rgb[1] * a;
                        d[o + 2] = bB * (1 - a) + pc.rgb[2] * a;
                        d[o + 3] = 255;
                    } else {
                        d[o] = pc.rgb[0]; d[o + 1] = pc.rgb[1]; d[o + 2] = pc.rgb[2];
                        d[o + 3] = pc.a;
                    }
                }
            }
            ctx.putImageData(img, 0, 0);
            this._raster = cv;
            this._rasterN = W;
        },
        _reset: function () {
            var size = this._map.getSize();
            var tl = this._map.containerPointToLayerPoint([0, 0]);
            this._canvas.width = size.x;
            this._canvas.height = size.y;
            L.DomUtil.setPosition(this._canvas, tl);
            this._draw();
        },
        _draw: function () {
            var ctx = this._canvas.getContext("2d");
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
            var dom = this._dom, map = this._map, b = dom.bbox, n = dom.n;
            var sw = map.latLngToContainerPoint([b[1], b[0]]);
            var ne = map.latLngToContainerPoint([b[3], b[2]]);
            var x = Math.min(sw.x, ne.x), y = Math.min(sw.y, ne.y);
            var w = Math.abs(ne.x - sw.x), h = Math.abs(ne.y - sw.y);
            if (w < 2 || h < 2) return;
            this._cellPx = w / n;
            if (!this._raster) this._makeRaster();
            // 平滑开关按图层区分：
            //   水深/风险/最大淹没 —— 关掉插值，色块边界保持硬边，淹没范围一眼可辨
            //   地形            —— 打开插值，地形本来就是连续曲面，硬边只会放大成
            //                      一个个方块（这是之前"地形糊/锯齿"的另一半原因）
            ctx.imageSmoothingEnabled = (this._mode === "terrain");
            if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = "high";
            var rn = this._rasterN || n;
            ctx.drawImage(this._raster, 0, 0, rn, rn, x, y, w, h);
            if (this._mode === "depth" || this._mode === "maxd") {
                this._contours(ctx, x, y, w, h);
            }
        },
        _contours: function (ctx, x, y, w, h) {
            var dom = this._dom, n = dom.n, cw = w / n, ch = h / n;
            var f = this._field;
            if (!f) return;
            // 只画淹没外边界（白描边，界定"到底淹到哪"）；深度靠蓝色深浅表达，
            // 不再另加红色警告线——内涝区统一用深蓝，颜色语言保持单一
            var th = this._th || 0.05;
            var levels = [[th, "rgba(255,255,255,.95)", 1.7]];
            ctx.lineJoin = "round";
            for (var li = 0; li < levels.length; li++) {
                var t = levels[li][0];
                ctx.beginPath();
                for (var j = 0; j < n - 1; j++) {
                    for (var i = 0; i < n - 1; i++) {
                        var k = j * n + i;
                        var dA = f[k], dB = f[k + 1], dC = f[k + n + 1], dD = f[k + n];
                        var idx = (dA >= t ? 1 : 0) | (dB >= t ? 2 : 0) | (dC >= t ? 4 : 0) | (dD >= t ? 8 : 0);
                        if (idx === 0 || idx === 15) continue;
                        var xA = x + (i + 0.5) * cw, xB = x + (i + 1.5) * cw;
                        var yA = y + h - (j + 0.5) * ch, yC = y + h - (j + 1.5) * ch;
                        var pAB = [xA + cw * ip(dA, dB, t), yA];
                        var pBC = [xB, yA - ch * ip(dB, dC, t)];
                        var pCD = [xA + cw * ip(dD, dC, t), yC];
                        var pDA = [xA, yA - ch * ip(dA, dD, t)];
                        var segs = SEG[idx];
                        for (var s = 0; s < segs.length; s += 2) {
                            var a = PE(segs[s], pAB, pBC, pCD, pDA);
                            var b2 = PE(segs[s + 1], pAB, pBC, pCD, pDA);
                            ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]);
                        }
                    }
                }
                // 先压一道深色底，再描亮色线：浅色底图上边界也不会糊掉
                ctx.strokeStyle = "rgba(3,14,26,.55)";
                ctx.lineWidth = levels[li][2] + 2.4;
                ctx.stroke();
                ctx.strokeStyle = levels[li][1];
                ctx.lineWidth = levels[li][2];
                ctx.stroke();
            }
        },
    });

    function ip(a, b, t) { return a === b ? 0.5 : Math.max(0, Math.min(1, (t - a) / (b - a))); }
    function PE(e, top, right, bottom, left) { return e === 0 ? top : e === 1 ? right : e === 2 ? bottom : left; }
    var SEG = (function () {
        var t = []; for (var i = 0; i < 16; i++) t[i] = [];
        t[1] = [3, 0]; t[2] = [0, 1]; t[3] = [3, 1]; t[4] = [1, 2]; t[5] = [3, 0, 1, 2];
        t[6] = [0, 2]; t[7] = [3, 2]; t[8] = [2, 3]; t[9] = [2, 0]; t[10] = [0, 1, 2, 3];
        t[11] = [2, 1]; t[12] = [1, 3]; t[13] = [1, 0]; t[14] = [0, 3]; return t;
    })();

    function hex2rgb(hex) {
        var h = hex.replace("#", "");
        return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
    }
    // 可分离最大值膨胀：先沿行再沿列，(2r+1)^2 邻域取最大
    // 用于低缩放级别放大积水栅格的显示尺寸（仅渲染用，不改物理场）
    function dilate(f, n, r) {
        if (!r || r < 1) return f;
        var t = new Float32Array(f.length);
        for (var j = 0; j < n; j++) {
            var row = j * n;
            for (var i = 0; i < n; i++) {
                var m = 0;
                for (var d = -r; d <= r; d++) {
                    var x = i + d;
                    if (x < 0 || x >= n) continue;
                    var v = f[row + x];
                    if (v > m) m = v;
                }
                t[row + i] = m;
            }
        }
        var out = new Float32Array(f.length);
        for (var i2 = 0; i2 < n; i2++) {
            for (var j2 = 0; j2 < n; j2++) {
                var m2 = 0;
                for (var d2 = -r; d2 <= r; d2++) {
                    var y = j2 + d2;
                    if (y < 0 || y >= n) continue;
                    var v2 = t[y * n + i2];
                    if (v2 > m2) m2 = v2;
                }
                out[j2 * n + i2] = m2;
            }
        }
        return out;
    }
    var NB4I = [1, -1, 0, 0], NB4J = [0, 0, 1, -1];
    // ===== 积水深度分级（分级硬边，不用连续插值）=====
    // 全蓝系：越深越接近藏青，≥1 m 用最深一档；极端核心另用红色等高线（≥1m 线）勾出
    var DEPTH_CLASSES = [
        { lo: 0.03, name: "3–10 cm", rgb: [58, 140, 255], a: 185 },
        { lo: 0.10, name: "10–20 cm", rgb: [30, 104, 240], a: 208 },
        { lo: 0.20, name: "20–35 cm", rgb: [18, 72, 220], a: 218 },
        { lo: 0.35, name: "35–60 cm", rgb: [10, 48, 190], a: 226 },
        { lo: 0.60, name: "60–100 cm", rgb: [6, 30, 150], a: 232 },
        { lo: 1.00, name: "≥ 100 cm", rgb: [2, 14, 96], a: 236 },
    ];
    function depthClass(v) {
        for (var i = DEPTH_CLASSES.length - 1; i >= 0; i--) if (v >= DEPTH_CLASSES[i].lo) return i;
        return -1;
    }
    // 分级色（给图例 / 标注 / 列表用）
    function depthHex(v) {
        var i = depthClass(v);
        if (i < 0) return "#2f7cff";
        var c = DEPTH_CLASSES[i].rgb;
        return "#" + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
    }
    function depthRamp(v) {
        var i = depthClass(v);
        if (i < 0) i = 0;
        var c = DEPTH_CLASSES[i];
        return [c.rgb[0], c.rgb[1], c.rgb[2], c.a];
    }
    // DEM 地形配色（浅色晕渲）。四套预设，用 ?pal=0..3 切换，默认 0：
    //   0 经典地形  低洼青绿 → 平原草绿 → 台地麦黄 → 丘陵浅褐 → 山地灰褐 → 峰脊近白
    //   1 大地淡彩  米灰为底，只在起伏处泛浅褐，最"干净"，最衬深蓝积水
    //   2 冷调灰绿  整体偏青灰，和积水蓝同一色系，画面最统一
    //   3 标准分层  饱和度高一些的经典分层设色，投影最醒目
    var PALETTES = [
        [[132, 170, 143], [159, 187, 146], [186, 201, 152], [210, 207, 160],
         [220, 197, 162], [203, 179, 156], [183, 165, 151], [212, 209, 203]],
        [[196, 202, 186], [204, 207, 187], [214, 213, 190], [222, 214, 188],
         [222, 205, 181], [212, 192, 170], [199, 180, 162], [223, 218, 209]],
        [[150, 175, 168], [166, 188, 174], [184, 199, 180], [200, 208, 186],
         [206, 205, 186], [194, 191, 178], [180, 178, 170], [214, 214, 208]],
        [[120, 172, 118], [156, 190, 116], [196, 203, 124], [224, 208, 137],
         [226, 186, 130], [198, 158, 122], [172, 140, 122], [224, 220, 212]],
        // 4 高对比地形：低地冷绿 → 丘陵暖黄 → 山地赭石 → 高山灰白。
        //    相邻档位明度差 ≥18，投影仪上也能看出山脊走向；配合山体阴影层次最清。
        [[110, 158, 120], [148, 184, 126], [190, 200, 132], [226, 208, 142],
         [222, 176, 124], [196, 146, 116], [162, 126, 114], [236, 232, 226]],
        // 5 柔和地形（12 档）：档位更密、相邻色差更小，插值后过渡连续，
        //    适合高倍放大观察 —— 4 档那种 8 段配色在大画布上会出现明显分带
        [[104, 152, 118], [126, 166, 118], [150, 180, 122], [172, 192, 126],
         [194, 202, 130], [212, 208, 134], [224, 206, 138], [226, 196, 134],
         [224, 184, 128], [214, 168, 122], [198, 150, 118], [182, 136, 114]],
        // 6 连续晕渲（默认用于地形图层）：24 档近似连续渐变。
        //    8~12 档在大画布上会把山脊画成一条条硬边"假等高线"，
        //    密档 + 平滑插值后才像真正的地形晕渲图。
        //    色序刻意压低中高段的色相跳变：早期版本在"米黄 → 赭褐"处跨度过大，
        //    山脊被画成一圈橙褐色描边，像给地形勾了轮廓线。现在让高段渐进泛褐，
        //    只在最高处微微发灰，山脊靠阴影而非色相来体现。
        [[96, 142, 116], [108, 152, 118], [122, 161, 120], [136, 170, 122],
         [150, 178, 124], [164, 186, 126], [177, 193, 128], [190, 199, 131],
         [201, 203, 134], [211, 206, 137], [219, 208, 140], [225, 208, 143],
         [229, 206, 145], [231, 202, 146], [231, 197, 146], [229, 191, 145],
         [226, 185, 143], [221, 178, 140], [215, 170, 137], [208, 162, 134],
         [200, 153, 131], [191, 144, 128], [181, 135, 125], [219, 214, 207]]
    ];
    // 默认用连续晕渲（索引 5）。旧默认是 8 档的 0 号，色阶跨度大，
    // 放大会看到山脊被切成一条条硬边色带；连续色阶才是地形图该有的样子。
    var palIdx = 5;
    try {
        var pm = /[?&]pal=(\d)/.exec(location.search);
        if (pm) palIdx = Math.max(0, Math.min(PALETTES.length - 1, +pm[1]));
    } catch (e) { }
    function terrainRamp(t) {
        var st = PALETTES[palIdx];
        var p = t * (st.length - 1), i = Math.min(st.length - 2, Math.floor(p)), k = p - i;
        return [
            st[i][0] + (st[i + 1][0] - st[i][0]) * k,
            st[i][1] + (st[i + 1][1] - st[i][1]) * k,
            st[i][2] + (st[i + 1][2] - st[i][2]) * k,
        ];
    }

    // ============ 控件 ============
    // 参数变化只标记"待演算"，不自动重算——用户点「开始演算」才计算
    function markDirty() {
        state.dirty = true;
        var b = $("btn-run");
        if (b) b.classList.add("dirty");
    }
    function clearDirty() {
        state.dirty = false;
        var b = $("btn-run");
        if (b) b.classList.remove("dirty");
        var h = $("map-fresh");
        if (h) h.classList.add("hide");
    }
    function showFreshHint(text) {
        var h = $("map-fresh");
        if (!h) return;
        h.textContent = text;
        h.classList.remove("hide");
    }

    function bindUI() {
        var qEl = $("city-q");
        if (qEl) {
            var deb = null;
            qEl.addEventListener("input", function () {
                cityQuery = this.value;
                clearTimeout(deb);
                deb = setTimeout(applyCityFilter, 90);
            });
            // Esc 清空搜索
            qEl.addEventListener("keydown", function (e) {
                if (e.key === "Escape") { this.value = ""; cityQuery = ""; applyCityFilter(); }
            });
        }
        $("scn-mode").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.scnMode = b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            $("scn-design").classList.toggle("hide", state.scnMode !== "design");
            $("scn-event").classList.toggle("hide", state.scnMode !== "event");
            renderRainBox(); markDirty();
        });
        $("p-chips").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.P = +b.dataset.v; buildPchips(); renderRainBox(); markDirty();
        });
        $("d-chips").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.dur = +b.dataset.v; buildDchips(); renderRainBox(); markDirty();
        });
        $("f-range").addEventListener("input", function () {
            state.factor = this.value / 100;
            $("lab-f").textContent = state.factor.toFixed(2) + " ×";
            renderRainBox();
        });
        $("f-range").addEventListener("change", function () { markDirty(); });

        $("engine-toggle").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.engine = b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            $("ml-block").classList.toggle("hide", state.engine !== "ml");
            buildMLParams(); markDirty();
        });
        $("algo").addEventListener("change", function () {
            state.algo = this.value; buildMLParams(); markDirty();
        });
        $("btn-run").addEventListener("click", function () { run(true); });

        $("layer-tabs").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.layer = b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            updateLegend(); refreshLayer();
        });
        $("th-tabs").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.dispTh = +b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            if (state.layerObj) { state.layerObj._th = state.dispTh; state.layerObj._raster = null; state.layerObj._reset(); }
            updateLegend();
        });
        $("view-tabs").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            if (b.dataset.v === "pond") fitPonds(); else fitMap();
        });
        $("extent-toggle").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            if (state.extent === b.dataset.v) return;
            state.extent = b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            syncExtentLabel();
            if (state.city) selectCity(state.city.id);
        });

        $("btn-play").addEventListener("click", togglePlay);
        $("btn-reset").addEventListener("click", function () { pause(); setFrame(0); });
        $("btn-peak").addEventListener("click", function () {
            if (!state.result) return;
            pause();
            setFrame(state.peakIdx != null ? state.peakIdx : state.result.frames.length - 1);
        });
        $("tl-range").addEventListener("input", function () { pause(); setFrame(+this.value); });
        $("speed").addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.speed = +b.dataset.v;
            this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        });

        window.addEventListener("keydown", function (e) {
            if (e.code === "Space") { e.preventDefault(); togglePlay(); }
            if (e.code === "ArrowRight") setFrame(Math.min(state.result.frames.length - 1, state.frameIdx + 1));
            if (e.code === "ArrowLeft") setFrame(Math.max(0, state.frameIdx - 1));
        });
        window.addEventListener("resize", function () {
            Object.keys(state.charts).forEach(function (k) { state.charts[k] && state.charts[k].resize(); });
        });
    }

    function buildPchips() {
        $("p-chips").innerHTML = [5, 10, 20, 50, 100].map(function (p) {
            return '<button data-v="' + p + '"' + (p === state.P ? ' class="on"' : "") + ">" + p + " 年</button>";
        }).join("");
        $("lab-p").textContent = state.P + " 年";
    }
    function buildDchips() {
        $("d-chips").innerHTML = [1, 2, 3, 6, 12].map(function (d) {
            return '<button data-v="' + d + '"' + (d === state.dur ? ' class="on"' : "") + ">" + d + " h</button>";
        }).join("");
        $("lab-d").textContent = state.dur + " h";
    }
    function buildEventList() {
        var evs = (state.city && state.city.events) || [];
        if (!evs.length) {
            $("event-list").innerHTML = '<p class="tip">该城市暂无收录的历史场次，可用设计暴雨情景</p>';
            return;
        }
        $("event-list").innerHTML = evs.slice(0, 6).map(function (e, i) {
            return '<button data-i="' + i + '"' + (i === state.eventIdx ? ' class="on"' : "") + ">" +
                e.date + " · " + e.name + "<br>实测最大 <em>" + fmt(e.max_rainfall, 1) + " mm/h</em> · 过程 <em>" +
                fmt(e.total_rainfall, 0) + " mm</em></button>";
        }).join("");
        var box = $("event-list");
        box.onclick = function (e) {
            var b = e.target.closest("button"); if (!b) return;
            state.eventIdx = +b.dataset.i;
            box.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
            renderRainBox(); markDirty();
        };
    }

    // 场景降雨参数
    function scenario() {
        var c = state.city, f = state.factor;
        if (state.scnMode === "event") {
            var ev = (c.events || [])[state.eventIdx] || (c.events || [])[0];
            if (!ev) return { total: 150 * f, durH: 3, label: "设计情景", peak: 60 };
            var dur = Math.max(2, Math.min(12, ev.total_rainfall / Math.max(20, ev.max_rainfall * 0.42)));
            return {
                total: ev.total_rainfall * f, durH: Math.round(dur * 10) / 10,
                label: ev.date + " " + ev.name, peak: ev.max_rainfall, date: ev.date,
            };
        }
        var intensity = H.idf(c.storm, state.P, state.dur * 60);
        return {
            total: intensity * state.dur * f, durH: state.dur,
            label: "设计暴雨 P=" + state.P + "a · " + state.dur + "h",
            peak: intensity, date: null,
        };
    }

    function renderRainBox() {
        if (!state.city) return;
        var s = scenario();
        var iAvg = s.total / s.durH;
        $("rain-box").innerHTML =
            '<span class="rname">' + s.label + "</span>" +
            "设计雨强 <b>" + fmt(iAvg, 1) + "</b> mm/h · 降雨总量 <b>" + fmt(s.total, 0) + "</b> mm<br>" +
            "现状排水能力 <b>" + fmt(state.city.drain.capacity_mm_h, 0) + "</b> mm/h · 覆盖率 <b>" +
            fmt(state.city.drain.coverage * 100, 0) + "</b>%<br>" +
            "雨强/排水比 <b>" + fmt(iAvg / Math.max(1, state.city.drain.capacity_mm_h), 2) + "</b>";
    }

    // ============ 演算 ============
    function run(manual) {
        if (!state.dom || state.busy) return;
        var s = scenario();
        state.busy = true;
        overlay(true, "正在演算水动力过程…", 0.15);
        setTimeout(function () {
            try {
                var t0 = performance.now();
                var recede = Math.max(1.5, s.durH * 1.35);
                var cfg = {
                    totalMm: s.total, durationH: s.durH, recedeH: recede,
                    steps: 300, frameEvery: 5, peakAt: 0.38, skew: 1.9,
                };
                var sim, acc = null;
                if (state.engine === "ml") {
                    acc = runSurrogate(s, cfg);
                    sim = acc.sim;
                } else {
                    sim = H.runSim(state.dom, cfg);
                }
                var ms = performance.now() - t0;
                state.scn = s;
                state.result = {
                    frames: sim.frames, hmax: sim.hmax, rain: sim.rain, simMs: sim.simMs,
                    totalMs: ms, outfall: sim.outfall, acc: acc, cfg: cfg,
                };
                // 问题点与风险：以最大淹没场为准
                var hmaxF = new Float32Array(state.dom.N);
                for (var i = 0; i < state.dom.N; i++) hmaxF[i] = sim.hmax[i];
                state.result.zones = H.extractZones(state.dom, hmaxF, 0.05);
                var rk = H.assess(state.dom, hmaxF, hmaxF, s.total);
                state.result.risk = rk;

                $("meta-dt").textContent = fmt(sim.dt, 0) + " s";
                $("meta-cost").textContent = fmt(ms, 0) + " ms";
                buildTimeline();
                renderCharts();
                renderStatic();
                // 定位到积水最盛的一帧（峰值），默认定格展示，不自动播放
                var pk = 0, pv = -1;
                for (var fi = 0; fi < sim.frames.length; fi++) {
                    if (sim.frames[fi].areaKm2 > pv) { pv = sim.frames[fi].areaKm2; pk = fi; }
                }
                state.peakIdx = pk;
                pause();
                setFrame(0);
                if (state.engine === "ml") renderAcc(acc); else renderAcc(null);
                logCal();
                if (state.probeCell) drawProbe();
                if (state.jumpFrame !== undefined && state.jumpFrame !== null) {
                    // 来自分享链接的定格帧：保持住，便于截图/复现，手动演算后释放
                    setFrame(state.jumpFrame);
                    if (manual) state.jumpFrame = null;
                } else {
                    setFrame(pk);
                }
                // 分享链接里的点位：直接展开积水过程线
                if (state.probeHash) {
                    var pp = state.probeHash.split(",");
                    if (pp.length === 2) probeAt(+pp[0], +pp[1]);
                    state.probeHash = null;
                } else {
                    // 视野默认聚焦到积水区，40 km 全域里那几片水面太小看不清
                    fitPonds();
                }
                // 容器尺寸在首帧可能还没定型，300 ms 后按当前视野模式再校一次
                setTimeout(function () {
                    if (!state.dom) return;
                    state.map.invalidateSize();
                    if (state.viewMode === "pond") fitPonds(); else fitMap();
                }, 300);
            } catch (err) {
                console.error(err);
                toast("演算失败：" + err.message);
            }
            overlay(false);
            state.busy = false;
            clearDirty();
        }, 40);
    }

    // ---------- 代理模型 ----------
    var FEAT_KEYS = ["elevNorm", "slope", "accNorm", "imperv", "cn", "drainMh", "urban", "dstore", "logP", "dur", "zRel"];

    function buildFeatureMatrix(dom, scen) {
        var n = dom.n, N = dom.N, X = new Float32Array(N * FEAT_KEYS.length);
        var zs = [];
        for (var i = 0; i < N; i++) if (dom.mask[i]) zs.push(dom.z[i]);
        zs.sort(function (a, b) { return a - b; });
        var lo = zs[Math.floor(zs.length * 0.03)], hi = zs[Math.floor(zs.length * 0.97)];
        var rel = Math.max(5, hi - lo);
        var logP = Math.log10(Math.max(1, scen.label && scen.P ? scen.P : 50));
        for (var k = 0; k < N; k++) {
            var o = k * FEAT_KEYS.length;
            X[o] = Math.max(0, Math.min(1, (dom.z[k] - lo) / rel));
            X[o + 1] = Math.min(0.05, dom.slope[k]) * 20;
            X[o + 2] = dom.accNorm[k];
            X[o + 3] = dom.imperv[k];
            X[o + 4] = dom.cn[k];
            X[o + 5] = dom.drainMh[k];
            X[o + 6] = dom.urban[k];
            X[o + 7] = dom.dstore[k] * 100;
            X[o + 8] = logP;
            X[o + 9] = scen.durH;
            X[o + 10] = Math.max(0, Math.min(1, (dom.z[k] - lo) / rel));   // 备用相对高程
        }
        return X;
    }

    function runSurrogate(s, cfg) {
        var dom = state.dom;
        var base = { totalMm: s.total, durationH: s.durH, recedeH: cfg.recedeH, steps: 200, frameEvery: 5, peakAt: 0.38, skew: 1.9 };
        // ① 多情景物理样本
        // 必须在与推理完全相同分辨率的计算域上取样：洼地蓄水容量随网格尺度变化，
        // 粗网格训练 + 细网格推理会让特征分布彻底错位（R² 会变成负的）。
        var coarse = state.dom;
        var scenSet = [
            { f: 0.6, P: 20 }, { f: 0.8, P: 50 }, { f: 1.0, P: 100 }, { f: 1.3, P: 100 }, { f: 0.9, P: 20 },
        ];
        var Xs = [], Y1 = [], Y2 = [], Y3 = [], Xh = null, Yh = null;
        var nf = FEAT_KEYS.length;
        var stride = Math.max(1, Math.floor(coarse.N / 1600));   // 每情景约 1600 个样本格
        for (var si = 0; si < scenSet.length; si++) {
            var sc = scenSet[si];
            var c2 = Object.assign({}, base, { totalMm: s.total * sc.f, durationH: s.durH });
            var sim2 = H.runSim(coarse, c2);
            var par2 = H.fitHydrograph(sim2.frames, coarse.N, sim2.dt / 3600);
            var X2 = buildFeatureMatrix(coarse, { durH: s.durH, P: sc.P });
            // 分层抽样：积水格（>15cm）与非积水格各取一半。
            // 若纯随机抽样，积水格只占 1.5%，回归会被"薄水膜"主导，学不到极值。
            var hiCells = [], loCells = [];
            for (var k = 0; k < coarse.N; k++) {
                if (!coarse.mask[k]) continue;
                if (par2.hmax[k] >= 0.15) hiCells.push(k);        // 积水格全取
                else if (k % stride === 0) loCells.push(k);        // 非积水格按步长抽
            }
            var pick = (si === 2) ? [] : hiCells.slice(0, 1500).concat(loCells.slice(0, 1500));
            for (var pi = 0; pi < pick.length; pi++) {
                var kp = pick[pi], op = kp * nf;
                Xs.push([X2[op], X2[op + 1], X2[op + 2], X2[op + 3], X2[op + 4], X2[op + 5], X2[op + 6], X2[op + 7], X2[op + 8], X2[op + 9], X2[op + 10]]);
                // 目标：峰值水深（cm）取对数，跨越 5cm~200cm 三个量级
                Y1.push(Math.log1p(par2.hmax[kp] * 100)); Y2.push(par2.tpeak[kp]); Y3.push(par2.tau[kp]);
            }
            if (si === 2) {   // 留出 P100 / 当前历时 作为验证集
                Yh = { hmax: par2.hmax, tpeak: par2.tpeak, tau: par2.tau };
                Xh = X2;
            }
        }
        // 抽样
        var rnd = mulberry32(20260720);
        var idx = Xs.map(function (_, i) { return i; });
        for (var i2 = idx.length - 1; i2 > 0; i2--) { var t = Math.floor(rnd() * (i2 + 1)); var tt = idx[i2]; idx[i2] = idx[t]; idx[t] = tt; }
        var cap = 6000;
        if (idx.length > cap) idx = idx.slice(0, cap);
        var split = Math.floor(idx.length * 0.82);
        var trI = idx.slice(0, split), teI = idx.slice(split);
        var Xtr = trI.map(function (i) { return Xs[i]; });
        var params = Object.assign({}, ML.defaultParams(state.algo), state.mlParams[state.algo] || {},
            { n_estimators: 40 });
        var t0 = performance.now();
        var m1 = ML.train(Xtr, trI.map(function (i) { return Y1[i]; }), state.algo, params, 11);
        var m2 = ML.train(Xtr, trI.map(function (i) { return Y2[i]; }), state.algo, params, 22);
        var m3 = ML.train(Xtr, trI.map(function (i) { return Y3[i]; }), state.algo, params, 33);
        var trainMs = performance.now() - t0;

        // ② 精度评估（对留出情景的粗网格）
        var p1 = ML.predictBatch(m1, Xh), p2 = ML.predictBatch(m2, Xh), p3 = ML.predictBatch(m3, Xh);
        var yh = [], ph = [], yPk = [], pPk = [];
        for (var k2 = 0; k2 < coarse.N; k2++) {
            if (!coarse.mask[k2]) continue;
            yh.push(Math.log1p(Yh.hmax[k2] * 100)); ph.push(Math.max(0, p1[k2]));
            if (Yh.hmax[k2] > 0.05) { yPk.push(Yh.tpeak[k2]); pPk.push(p2[k2]); }
        }
        var met = ML.metrics(yh, ph, Math.log1p(15));       // 阈值 15cm（对数尺度）
        var metT = ML.metrics(yPk, pPk, -1);
        // 积水范围一致性：以 15cm 为界的 IoU（比 F1 更直观地反映"淹到哪儿"）
        var tpN = 0, fpN = 0, fnN = 0, apeSum = 0, apeN = 0;
        for (var k5 = 0; k5 < coarse.N; k5++) {
            if (!coarse.mask[k5]) continue;
            var ya = Yh.hmax[k5], pa = Math.expm1(Math.max(0, p1[k5])) / 100;
            if (ya >= 0.15 && pa >= 0.15) tpN++;
            else if (pa >= 0.15) fpN++;
            else if (ya >= 0.15) fnN++;
            if (ya >= 0.05) { apeSum += Math.abs(pa - ya) / ya; apeN++; }
        }
        var iou = tpN / Math.max(1, tpN + fpN + fnN);

        // ③ 高分辨率推理
        var t1 = performance.now();
        var Xf = buildFeatureMatrix(dom, { durH: s.durH, P: state.P });
        var rows = [];
        for (var k3 = 0; k3 < dom.N; k3++) {
            var o3 = k3 * nf;
            rows.push([Xf[o3], Xf[o3 + 1], Xf[o3 + 2], Xf[o3 + 3], Xf[o3 + 4], Xf[o3 + 5], Xf[o3 + 6], Xf[o3 + 7], Xf[o3 + 8], Xf[o3 + 9], Xf[o3 + 10]]);
        }
        var q1 = ML.predictBatch(m1, rows), q2 = ML.predictBatch(m2, rows), q3 = ML.predictBatch(m3, rows);
        var inferMs = performance.now() - t1;

        // ④ 物理约束降尺度（physics-informed downscaling）
        // 代理模型能可靠预测"积多少水"，但难以逐格判断"哪一格积水"——那由 179 m
        // 尺度的地形细节决定。因此：ML 给出积水总量与历时形状，洼蓄容量先验负责
        // 把水量分配到真实洼地，两者结合得到既保量、又定位正确的淹没场。
        var predM = new Float32Array(dom.N);
        var Amask = 0;
        for (var k6 = 0; k6 < dom.N; k6++) {
            if (!dom.mask[k6] || dom.water[k6]) continue;
            Amask += dom.cellArea;
            var pm = Math.expm1(Math.max(0, q1[k6])) / 100;
            if (pm > 2.0) pm = 2.0;
            predM[k6] = pm;
        }
        // 面状薄水膜取预测中位数；只有高于中位数的部分才计入"成塘"水量
        var tmp = [];
        for (var kt = 0; kt < dom.N; kt++) if (dom.mask[kt] && !dom.water[kt]) tmp.push(predM[kt]);
        tmp.sort(function (a, b) { return a - b; });
        var sheetD = tmp.length ? tmp[Math.floor(tmp.length * 0.5)] : 0.02;
        var Vpond = 0;
        for (var kv = 0; kv < dom.N; kv++) {
            if (!dom.mask[kv] || dom.water[kv]) continue;
            if (predM[kv] > sheetD) Vpond += (predM[kv] - sheetD) * dom.cellArea;
        }
        var rank = [];
        for (var k7 = 0; k7 < dom.N; k7++) {
            if (dom.mask[k7] && !dom.water[k7] && dom.dstore[k7] > 0.12) rank.push(k7);
        }
        rank.sort(function (a, b) { return dom.dstore[b] - dom.dstore[a]; });
        var pondD = new Float32Array(dom.N);
        var left = Vpond;
        for (var ri = 0; ri < rank.length && left > 0; ri++) {
            var kr = rank[ri];
            var give = Math.min(dom.dstore[kr], left / dom.cellArea);
            pondD[kr] = give;
            left -= give * dom.cellArea;
        }
        for (var k8 = 0; k8 < dom.N; k8++) predM[k8] = dom.mask[k8] ? (sheetD + pondD[k8]) : 0;

        // 用降尺度后的场重新评估（这才是屏幕上显示的淹没范围）
        tpN = 0; fpN = 0; fnN = 0;
        for (var k9 = 0; k9 < dom.N; k9++) {
            if (!dom.mask[k9]) continue;
            var ya2 = Yh.hmax[k9], pa2 = predM[k9];
            if (ya2 >= 0.15 && pa2 >= 0.15) tpN++;
            else if (pa2 >= 0.15) fpN++;
            else if (ya2 >= 0.15) fnN++;
        }
        iou = tpN / Math.max(1, tpN + fpN + fnN);

        // ⑤ 重建过程帧
        var T = s.durH + cfg.recedeH;
        var nF = 66, dt = T / nF;
        var frames = [];
        var hmax = new Float32Array(dom.N);
        var rainSeries = H.makeRain({ totalMm: s.total, durationH: s.durH, recedeH: cfg.recedeH, steps: nF, peakAt: 0.38, skew: 1.9 }).series;
        for (var f2 = 0; f2 < nF; f2++) {
            var t3 = (f2 + 1) * dt;
            var q16 = new Uint16Array(dom.N);
            var area = 0, vol = 0, maxD = 0, sumD = 0, cnt = 0, a2 = 0, a5 = 0;
            for (var k4 = 0; k4 < dom.N; k4++) {
                if (!dom.mask[k4] || dom.water[k4]) continue;
                var hm = Math.max(0, Math.min(3, predM[k4]));
                var tp = Math.max(0.05, q2[k4]);
                var tau = Math.max(0.1, q3[k4]);
                var d;
                if (t3 <= tp) { var xr = tp > 0 ? t3 / tp : 1; d = hm * xr * xr; }
                else d = hm * Math.exp(-(t3 - tp) / tau);
                if (d > hmax[k4]) hmax[k4] = d;
                q16[k4] = d > 65.535 ? 65535 : Math.round(d * 1000);
                vol += d * dom.cellArea;
                if (d >= 0.15) { cnt++; area += dom.cellArea; sumD += d; if (d > maxD) maxD = d; }
                if (d >= 0.02) a2 += dom.cellArea;
                if (d >= 0.05) a5 += dom.cellArea;
            }
            frames.push({
                t: t3, rain: rainSeries[f2] || 0, depths: q16,
                areaKm2: area / 1e6, areaWet: a2 / 1e6, areaDeep: a5 / 1e6,
                maxDepth: maxD, meanDepth: cnt ? sumD / cnt : 0, volume: vol * 1e-4, points: cnt,
            });
        }
        return {
            sim: { frames: frames, hmax: hmax, rain: { total: s.total }, simMs: inferMs, dt: dt * 3600, outfall: 0 },
            trainMs: trainMs, inferMs: inferMs, metrics: met, metricsT: metT,
            iou: iou, mape: apeN ? apeSum / apeN : 0,
            nTrain: idx.length, algo: state.algo,
        };
    }

    function mulberry32(a) {
        return function () {
            a = (a + 0x6d2b79f5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ============ 时间轴 ============
    function buildTimeline() {
        var fs = state.result.frames;
        var rng = $("tl-range");
        rng.max = fs.length - 1; rng.value = 0;
        var mx = Math.max.apply(null, fs.map(function (f) { return f.rain; })) || 1;
        $("tl-rain").innerHTML = fs.map(function (f) {
            var hgt = Math.round(f.rain / mx * 13);
            return '<i style="height:' + hgt + 'px"></i>';
        }).join("");
        // 面积演变条：每帧积水面积，一眼看出涨落
        var amx = Math.max.apply(null, fs.map(function (f) { return f.areaKm2; })) || 1;
        $("tl-area").innerHTML = fs.map(function (f) {
            var hgt = Math.max(1, Math.round(f.areaKm2 / amx * 12));
            return '<i style="height:' + hgt + 'px"></i>';
        }).join("");
        // 峰值帧刻度
        var pk = 0, pv = -1;
        fs.forEach(function (f, i) { if (f.areaKm2 > pv) { pv = f.areaKm2; pk = i; } });
        $("tl-marks").innerHTML = '<b style="left:' + (pk / Math.max(1, fs.length - 1) * 100) +
            '%" title="峰值帧 T+' + fmt(fs[pk].t, 1) + 'h"></b>';
        $("tl-peak").textContent = "峰 " + fmt(pv, 1) + " km²";
    }

    function setFrame(i) {
        var res = state.result; if (!res) return;
        i = Math.max(0, Math.min(res.frames.length - 1, i));
        state.frameIdx = i;
        var f = res.frames[i];
        $("tl-range").value = i;
        $("tl-time").textContent = "T + " + fmt(f.t, 1) + " h";
        $("s-t").textContent = fmt(f.t, 1) + " h";
        $("s-rain").textContent = fmt(f.rain, 0) + " mm/h";
        var pf = i > 0 ? res.frames[i - 1] : null;
        var dl = pf ? f.areaKm2 - pf.areaKm2 : 0;
        $("s-area").innerHTML = fmt(f.areaKm2, 1) + " km²" + (pf && Math.abs(dl) >= 0.05
            ? '<i class="dl ' + (dl > 0 ? "up" : "down") + '">' + (dl > 0 ? "▲" : "▼") + fmt(Math.abs(dl), 1) + "</i>" : "");
        $("s-max").textContent = fmt(f.maxDepth * 100, 0) + " cm";
        // 时间轴面积条同步高亮
        var bars = $("tl-area").children;
        for (var bi = 0; bi < bars.length; bi++) bars[bi].className = bi === i ? "on" : "";
        updateKPI(f);
        refreshLayer(f.depths);
        updatePlayheads(f.t);
        if (state.probeCell && !$("probe").classList.contains("hide")) {
            var kk = state.probeCell.k;
            $("probe-foot").innerHTML = "过程最大积水 <b>" + fmt(state.probeMax || 0, 1) + " cm</b> · 当前 <b>" +
                fmt(f.depths[kk] / 10, 1) + " cm</b> · 累积降雨 <b>" + fmt(state.probeRain || 0, 0) + " mm</b>";
        }
        $("tl-range").style.background =
            "linear-gradient(90deg, var(--cyan) 0%, var(--cyan) " + (i / Math.max(1, res.frames.length - 1) * 100) +
            "%, rgba(0,195,255,.15) " + (i / Math.max(1, res.frames.length - 1) * 100) + "%)";
    }

    function togglePlay() {
        if (!state.result) return;
        state.playing ? pause() : play();
    }
    var rafId = null, lastT = 0, acc = 0;
    function play() {
        if (!state.result) return;
        state.playing = true;
        $("btn-play").innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>';
        if (state.frameIdx >= state.result.frames.length - 1) setFrame(0);
        lastT = performance.now(); acc = 0;
        var step = function (ts) {
            if (!state.playing) return;
            var dt = ts - lastT; lastT = ts; acc += dt;
            var per = 110 / state.speed;
            if (acc >= per) {
                acc = 0;
                var ni = state.frameIdx + 1;
                if (ni >= state.result.frames.length) { pause(); setFrame(state.result.frames.length - 1); return; }
                setFrame(ni);
            }
            rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
    }
    function pause() {
        state.playing = false;
        if (rafId) cancelAnimationFrame(rafId);
        $("btn-play").innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    }

    // ============ 地图图层刷新 ============
    function refreshLayer(field) {
        if (!state.dom) return;
        var res = state.result;
        // 未演算（刚切换城市）：清空水深/风险图层。
        // 但「地形」是纯数据图层，不依赖演算结果 —— 用户往往是演算前先看地形，
        // 原来这里无条件 return，导致切城市后地形图整体消失（只剩卫星照），
        // 是"地形看不清"反馈的另一半原因。地形图层必须继续往下走。
        if (!res && state.layer !== "terrain") {
            if (state.layerObj) { try { state.map.removeLayer(state.layerObj); } catch (e) { } state.layerObj = null; }
            if (state.zoneLayer) { try { state.map.removeLayer(state.zoneLayer); } catch (e) { } state.zoneLayer = null; }
            return;
        }
        if (!field) {
            field = (res && res.frames[state.frameIdx]) ? res.frames[state.frameIdx].depths : null;
        }
        var f32 = null;
        if (field) {
            f32 = new Float32Array(state.dom.N);
            for (var i = 0; i < state.dom.N; i++) f32[i] = field[i] / 1000;
        }
        if (res && state.layer === "maxd") { f32 = res.hmax; }
        if (state.layer === "terrain") { f32 = state.dom.z; }
        if (!state.layerObj) {
            state.layerObj = new DepthLayer(state.dom);
            state.layerObj._zmin = minOf(state.dom.z, state.dom.mask);
            state.layerObj._zmax = maxOf(state.dom.z, state.dom.mask);
            state.layerObj._th = state.dispTh;
            state.layerObj._useLocal = (state.basemap === "local");
            state.layerObj.addTo(state.map);
        }
        state.layerObj._th = state.dispTh;
        state.layerObj._zmin = state.layerObj._zmin || 0;
        state.layerObj._zmax = state.layerObj._zmax || 100;
        state.layerObj._risk = res && res.risk ? res.risk.level : null;
        // 地形图层与演算结果无关，永远可以单独出图
        if (state.layer === "terrain") {
            state.layerObj.setField(state.dom.z, "terrain");
        } else if (!res) {
            // 走到这里只可能是非地形图层且无结果，安全兜底：不画
            state.layerObj.setField(null, state.layer === "risk" ? "risk" : "depth");
        } else if (state.layer === "risk") {
            state.layerObj.setField(res.hmax, "risk");
        } else if (state.layer === "maxd") {
            state.layerObj.setField(res.hmax, "maxd");
        } else {
            state.layerObj.setField(f32, "depth");
        }
        drawZones();
    }

    function minOf(arr, mask) {
        var m = Infinity;
        for (var i = 0; i < arr.length; i++) if ((!mask || mask[i]) && arr[i] < m) m = arr[i];
        return m === Infinity ? 0 : m;
    }
    function maxOf(arr, mask) {
        var m = -Infinity;
        for (var i = 0; i < arr.length; i++) if ((!mask || mask[i]) && arr[i] > m) m = arr[i];
        return m === -Infinity ? 1 : m;
    }

    function drawZones() {
        if (state.zoneLayer) { state.map.removeLayer(state.zoneLayer); state.zoneLayer = null; }
        var res = state.result;
        if (!res || (state.layer !== "depth" && state.layer !== "maxd" && state.layer !== "risk")) return;
        var g = L.layerGroup();
        // 前 6 处积水最深片区：带编号 + 常显水深标签，直接在地图上点出"哪个点、多深"
        res.zones.slice(0, 6).forEach(function (z, idx) {
            var cm = Math.round(z.maxDepth * 100);
            var c = depthHex(z.maxDepth);
            var left = idx % 2 === 1;      // 标签左右交错，避免密集处互相压盖
            var html = '<div class="hz">' +
                '<i class="hz-dot" style="background:' + c + '"></i>' +
                '<i class="hz-ring" style="border-color:' + c + '"></i>' +
                '<span class="hz-lab' + (left ? " l" : "") + '" style="border-color:' + c + '">' +
                '<b>' + (idx + 1) + "</b>" + cm + "<em>cm</em></span></div>";
            var icon = L.divIcon({ className: "", html: html, iconSize: [0, 0], iconAnchor: [0, 0] });
            var m = L.marker([z.lat, z.lon], { icon: icon, zIndexOffset: 900 - idx });
            m.bindTooltip("内涝点 " + (idx + 1) + " · 最深 " + cm + " cm · 淹没 " + fmt(z.areaKm2, 2) + " km² · 最低 " + fmt(z.minElev, 1) + " m",
                { className: "cty-tip", direction: "top", offset: [0, -10] });
            m.on("click", function () {
                state.map.flyTo([z.lat, z.lon], Math.max(state.map.getZoom(), 13), { duration: .8 });
                probeAt(z.lat, z.lon);          // 点内涝点 → 直接看该点积水过程线
            });
            g.addLayer(m);
        });
        g.addTo(state.map);
        state.zoneLayer = g;
    }

    function updateLegend() {
        var box = $("legend");
        // 初始化阶段（底图先于色阶定义被绑定）可能还没有色阶，直接跳过，
        // 否则会抛 TypeError、把整个初始化链打断
        if (!box || typeof DEPTH_CLASSES === "undefined") return;
        if (state.layer === "depth" || state.layer === "maxd") {
            box.innerHTML = DEPTH_CLASSES.map(function (c) {
                return '<span><i style="background:rgba(' + c.rgb.join(",") + "," + (c.a / 255) + ')"></i>' + c.name + "</span>";
            }).join("") + '<span class="lg-note">白线 = 淹没边界 · 显示阈值 ' + Math.round(state.dispTh * 100) + "cm</span>";
        } else if (state.layer === "risk") {
            box.innerHTML = LEVEL_NAMES.map(function (n, i) {
                return '<span><i style="background:' + LEVEL_COLORS[i] + '"></i>' + n + "</span>";
            }).join("");
        } else if (state.layer === "terrain") {
            // 地形图例：连续色带 + 实际高程区间，让"这条绿到底是多少米"有据可查
            var st2 = PALETTES[palIdx] || PALETTES[0];
            var segs = st2.map(function (c) {
                return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
            });
            var grad = "linear-gradient(90deg," + segs.join(",") + ")";
            var zr = "";
            if (state.dom) {
                var lo = Infinity, hi = -Infinity;
                var zz = state.dom.z, mk = state.dom.mask;
                for (var zi = 0; zi < zz.length; zi++) {
                    if (!mk[zi]) continue;
                    if (zz[zi] < lo) lo = zz[zi];
                    if (zz[zi] > hi) hi = zz[zi];
                }
                if (isFinite(lo)) zr = '<span class="lg-note">' + fmt(lo, 0) + " – " + fmt(hi, 0) + " m</span>";
            }
            box.innerHTML = '<span class="lg-ramp" style="display:inline-block;width:104px;height:7px;border-radius:3px;background:' + grad + '"></span>' +
                '<span>低 → 高</span>' + zr +
                '<span class="lg-note">地形晕渲 · 网格 ' + (state.dom ? Math.round(state.dom.dx) : "—") + " m</span>";
        } else {
            var bm = basemapById(state.basemap || "amap");
            box.innerHTML = "<span>底图 · " + bm.name + "</span>" +
                '<span class="lg-note">© ' + bm.attr + "</span>";
        }
    }

    // ============ 结果渲染 ============
    function renderStatic() {
        var res = state.result;
        var zs = res.zones.slice(0, 12);
        $("zone-list").innerHTML = zs.length ? zs.map(function (z, i) {
            var c = depthHex(z.maxDepth);
            return '<div class="zone-item" data-lat="' + z.lat + '" data-lon="' + z.lon + '">' +
                '<span class="zi" style="color:' + c + '">' + (i + 1) + "</span>" +
                '<span class="zt">' + fmt(z.areaKm2, 2) + " km²<em>最低 " + fmt(z.minElev, 1) + " m</em></span>" +
                '<span class="zd" style="color:' + c + '">' + Math.round(z.maxDepth * 100) + " cm<em>最大水深</em></span></div>";
        }).join("") : '<p class="empty">本情景未形成连片积水</p>';
        $("zone-list").onclick = function (e) {
            var it = e.target.closest(".zone-item"); if (!it) return;
            var la = +it.dataset.lat, lo = +it.dataset.lon;
            state.map.flyTo([la, lo], 13, { duration: .8 });
            probeAt(la, lo);
        };

        // 风险构成
        var st = res.risk.stats;
        $("hv-h").style.width = Math.min(100, st.H) + "%";
        $("hv-e").style.width = Math.min(100, st.E) + "%";
        $("hv-v").style.width = Math.min(100, st.V) + "%";
        $("hv-hv").textContent = fmt(st.H, 0);
        $("hv-ev").textContent = fmt(st.E, 0);
        $("hv-vv").textContent = fmt(st.V, 0);
        var badge = $("risk-badge");
        badge.textContent = levelNameByR(st.R) + " · 综合风险指数 " + fmt(st.R, 1);
        badge.style.background = levelColorByR(st.R) + "26";
        badge.style.color = levelColorByR(st.R);
        badge.style.border = "1px solid " + levelColorByR(st.R) + "66";
        updateLegend();
    }

    function updateKPI(f) {
        var res = state.result;
        var zmax = res.zones.length ? res.zones[0].maxDepth : 0;
        var deepN = res.zones.filter(function (z) { return z.maxDepth >= 0.15; }).length;
        var popD = state.city.pop_wan / state.city.area_km2 * 1e4;   // 人/km²
        var cards = [
            ["漫流面积 ≥5cm", fmt(f.areaDeep, 1), "km²"],
            ["积水面积 ≥15cm", fmt(f.areaKm2, 1), "km²"],
            ["最大水深", fmt(f.maxDepth * 100, 0), "cm"],
            ["平均水深", fmt(f.meanDepth * 100, 0), "cm"],
            ["积水体积", fmt(f.volume, 0), "万m³"],
            ["受影响人口", fmt(f.areaKm2 * popD / 1e4, 2), "万人"],
            ["内涝点 ≥15cm", deepN, "处"],
            ["极值深度", fmt(zmax * 100, 0), "cm"],
        ];
        $("kpi").innerHTML = cards.map(function (c) {
            return '<div class="k"><span>' + c[0] + "</span><b>" + c[1] + "<i>" + c[2] + "</i></b></div>";
        }).join("");
    }

    function renderAcc(acc) {
        var box = $("acc-box");
        if (!acc) {
            box.innerHTML = '<p class="empty">当前为水动力 CA 直接演算；切换到 ML 代理可查看精度与加速比</p>';
            return;
        }
        var sp = state.result.simMs / Math.max(1, acc.inferMs);
        box.innerHTML =
            '<div class="acc-grid">' +
            "<div><span>R²（峰值水深 ln）</span><b>" + fmt(acc.metrics.r2, 3) + "</b></div>" +
            "<div><span>积水范围 IoU</span><b>" + fmt(acc.iou, 2) + "</b></div>" +
            "<div><span>深度中位相对误差</span><b>" + fmt(acc.mape * 100, 0) + "%</b></div>" +
            "<div><span>训练样本</span><b>" + acc.nTrain + "</b></div>" +
            "</div>" +
            '<div class="speedup">训练 <b>' + fmt(acc.trainMs, 0) + " ms</b> · 推理 <b>" + fmt(acc.inferMs, 1) +
            " ms</b><br>相对水动力 CA 加速 <b>×" + fmt(sp, 0) + "</b>（同一情景）" +
            '<em style="display:block;margin-top:6px;color:#5d8ba1;font-size:9.5px;line-height:1.5">' +
            "代理模型给出积水总量与涨退形状；逐格定位由洼蓄先验约束。" +
            "用于多情景快速筛选，最终成果以水动力 CA 为准。</em></div>";
    }

    // ============ 图表 ============
    var CHART_BASE = {
        backgroundColor: "transparent",
        animation: false,
        grid: { left: 38, right: 38, top: 22, bottom: 22 },
        textStyle: { color: "#7ea3b8", fontSize: 10 },
        tooltip: {
            trigger: "axis", backgroundColor: "rgba(6,22,36,.94)", borderColor: "rgba(0,195,255,.3)",
            textStyle: { color: "#d6ecf6", fontSize: 10.5 }, axisPointer: { type: "line", lineStyle: { color: "rgba(0,211,255,.4)" } },
        },
    };
    var AXIS = {
        axisLine: { lineStyle: { color: "rgba(0,195,255,.2)" } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "rgba(0,195,255,.07)" } },
        axisLabel: { color: "#5d8ba1", fontSize: 9.5 },
    };

    function getChart(id) {
        if (!state.charts[id]) state.charts[id] = echarts.init($(id), null, { renderer: "canvas" });
        return state.charts[id];
    }

    function renderCharts() {
        var res = state.result, fs = res.frames;
        var ts = fs.map(function (f) { return f.t; });

        // ① 降雨 + 面积
        var c1 = getChart("c-hydro");
        var rPeak = 1, aPeak = 0.1;
        fs.forEach(function (f) {
            if (f.rain > rPeak) rPeak = f.rain;
            if (f.areaKm2 > aPeak) aPeak = f.areaKm2;
        });
        // 雨强轴上限取峰值向上取整到 10 的倍数，柱高占图高合理、不再被面积轴挤压
        var rTop = Math.max(10, Math.ceil(rPeak / 10) * 10);
        var aTop = Math.max(0.5, Math.ceil(aPeak * 1.15 * 10) / 10);
        c1.setOption(Object.assign({}, CHART_BASE, {
            legend: { top: 0, right: 4, itemWidth: 8, itemHeight: 6, textStyle: { color: "#7ea3b8", fontSize: 9 } },
            grid: { left: 40, right: 42, top: 26, bottom: 20 },
            xAxis: Object.assign({ type: "category", data: ts.map(function (t) { return fmt(t, 1); }), boundaryGap: false }, AXIS),
            yAxis: [
                Object.assign({ type: "value", name: "雨强 mm/h", nameTextStyle: { color: "#4d7387", fontSize: 9 }, splitLine: { show: false }, min: 0, max: rTop, interval: Math.max(1, Math.round(rTop / 4)) }, AXIS),
                Object.assign({ type: "value", name: "km²", nameTextStyle: { color: "#4d7387", fontSize: 9 }, min: 0, max: aTop }, AXIS),
            ],
            series: [
                {
                    name: "雨强", type: "bar", yAxisIndex: 0, data: fs.map(function (f) { return +f.rain.toFixed(1); }),
                    itemStyle: { color: "rgba(47,124,255,.7)", borderRadius: [2, 2, 0, 0] }, barWidth: "72%",
                    z: 1,
                },
                {
                    name: "积水面积(≥15cm)", type: "line", yAxisIndex: 1, smooth: true, symbol: "none",
                    data: fs.map(function (f) { return +f.areaKm2.toFixed(2); }),
                    lineStyle: { width: 2, color: "#00d3ff" }, areaStyle: { color: "rgba(0,211,255,.16)" },
                },
                {
                    name: "漫流面积(≥5cm)", type: "line", yAxisIndex: 1, smooth: true, symbol: "none",
                    data: fs.map(function (f) { return +f.areaDeep.toFixed(2); }),
                    lineStyle: { width: 1.2, color: "rgba(255,210,71,.8)", type: "dashed" },
                },
            ],
        }), true);

        // ② 体积 + 最大水深
        var c2 = getChart("c-vol");
        c2.setOption(Object.assign({}, CHART_BASE, {
            legend: { top: 0, right: 4, itemWidth: 8, itemHeight: 6, textStyle: { color: "#7ea3b8", fontSize: 9 } },
            xAxis: Object.assign({ type: "category", data: ts.map(function (t) { return fmt(t, 1); }), boundaryGap: false }, AXIS),
            yAxis: [
                Object.assign({ type: "value", name: "万m³", nameTextStyle: { color: "#4d7387", fontSize: 9 }, splitLine: { show: false } }, AXIS),
                Object.assign({ type: "value", name: "cm", nameTextStyle: { color: "#4d7387", fontSize: 9 } }, AXIS),
            ],
            series: [
                {
                    name: "积水体积", type: "line", smooth: true, symbol: "none",
                    data: fs.map(function (f) { return +f.volume.toFixed(0); }),
                    lineStyle: { width: 2, color: "#22c55e" }, areaStyle: { color: "rgba(34,197,94,.16)" },
                },
                {
                    name: "最大水深", type: "line", yAxisIndex: 1, smooth: true, symbol: "none",
                    data: fs.map(function (f) { return +(f.maxDepth * 100).toFixed(0); }),
                    lineStyle: { width: 1.8, color: "#ff6536" },
                },
            ],
        }), true);

        // ③ 风险面积
        var st = res.risk.stats;
        var c3 = getChart("c-level");
        c3.setOption(Object.assign({}, CHART_BASE, {
            grid: { left: 34, right: 12, top: 16, bottom: 26 },
            xAxis: Object.assign({ type: "category", data: LEVEL_NAMES, axisLabel: { color: "#5d8ba1", fontSize: 9, interval: 0 } }, AXIS),
            yAxis: Object.assign({ type: "value", name: "km²", nameTextStyle: { color: "#4d7387", fontSize: 9 } }, AXIS),
            series: [{
                type: "bar", barWidth: "56%",
                data: st.areaByLevel.map(function (v, i) {
                    return { value: +v.toFixed(1), itemStyle: { color: LEVEL_COLORS[i], borderRadius: [3, 3, 0, 0] } };
                }),
                label: { show: true, position: "top", color: "#7ea3b8", fontSize: 9 },
            }],
        }), true);

        // ④ 问题点深度分布
        var buckets = [[0.15, 0.3, "15-30"], [0.3, 0.5, "30-50"], [0.5, 0.8, "50-80"], [0.8, 1.2, "80-120"], [1.2, 99, ">120"]];
        var cnts = buckets.map(function (b) {
            return res.zones.filter(function (z) { return z.maxDepth >= b[0] && z.maxDepth < b[1]; }).length;
        });
        var c4 = getChart("c-zone");
        c4.setOption(Object.assign({}, CHART_BASE, {
            grid: { left: 34, right: 12, top: 16, bottom: 26 },
            xAxis: Object.assign({ type: "category", data: buckets.map(function (b) { return b[2]; }), axisLabel: { color: "#5d8ba1", fontSize: 9, interval: 0 } }, AXIS),
            yAxis: Object.assign({ type: "value", name: "处", nameTextStyle: { color: "#4d7387", fontSize: 9 } }, AXIS),
            series: [{
                type: "bar", barWidth: "52%",
                data: cnts.map(function (v, i) {
                    return { value: v, itemStyle: { color: ["#00d3ff", "#3b9dff", "#ffd247", "#ff6536", "#ff2b4d"][i], borderRadius: [3, 3, 0, 0] } };
                }),
                label: { show: true, position: "top", color: "#7ea3b8", fontSize: 9 },
            }],
        }), true);

        buildPlayheads();
        setTimeout(function () {
            Object.keys(state.charts).forEach(function (k) {
                if (state.charts[k]) state.charts[k].resize();
            });
            updatePlayheads(state.result.frames[state.frameIdx].t);
        }, 120);
    }

    function buildPlayheads() {
        document.querySelectorAll(".playhead").forEach(function (p) { p.remove(); });
        state.playheads = [];
        ["c-hydro", "c-vol"].forEach(function (id) {
            var host = $(id).parentNode;
            var ph = document.createElement("div");
            ph.className = "playhead";
            ph.style.cssText = "position:absolute;top:22px;bottom:22px;width:1px;background:#35e3ff;opacity:0;pointer-events:none;" +
                "box-shadow:0 0 8px #35e3ff;transition:left .08s linear;z-index:5";
            host.appendChild(ph);
            state.playheads.push({ el: ph, id: id });
        });
        updatePlayheads(0);
    }

    function updatePlayheads(t) {
        var res = state.result; if (!res) return;
        var tmax = res.frames[res.frames.length - 1].t;
        var pct = Math.max(0, Math.min(1, t / Math.max(0.01, tmax)));
        state.playheads.forEach(function (p) {
            var host = p.el.parentNode;
            var w = host.clientWidth;
            var left = 38 + pct * (w - 38 - 38);
            p.el.style.left = left + "px";
            p.el.style.opacity = 0.9;
        });
    }

    // ============ 率定参数 ============
    var HYDRO_PARAMS = [
        { k: "drainK", name: "管网过水折减", min: 0.25, max: 1.0, step: 0.02 },
        { k: "storeK", name: "洼蓄容量系数", min: 0.3, max: 2.0, step: 0.1 },
        { k: "iaRatio", name: "初损系数 Ia/S", min: 0.05, max: 0.35, step: 0.01 },
        { k: "inletK", name: "雨水口效率", min: 0.4, max: 1.4, step: 0.05 },
        { k: "cnAdj", name: "CN 修正", min: -10, max: 10, step: 1 },
        { k: "recessH", name: "洼地退水时间 (h)", min: 1, max: 18, step: 1 },
    ];
    var calLog = [];

    function buildHydroParams() {
        var box = $("hydro-params");
        box.innerHTML = HYDRO_PARAMS.map(function (p) {
            var v = H.PARAMS[p.k];
            return '<div class="mp"><div class="lab"><span>' + p.name + '</span><b>' + v + "</b></div>" +
                '<input type="range" class="rng hp" data-k="' + p.k + '" min="' + p.min + '" max="' + p.max +
                '" step="' + p.step + '" value="' + v + '"></div>';
        }).join("");
        box.querySelectorAll("input.hp").forEach(function (inp) {
            inp.addEventListener("input", function () {
                this.parentNode.querySelector(".lab b").textContent = this.value;
            });
            inp.addEventListener("change", function () {
                var o = {}; o[this.dataset.k] = +this.value;
                H.setParams(o);
                markDirty();
            });
        });
        $("btn-cal-reset").onclick = function () {
            H.setParams({ drainK: 0.45, storeK: 1.0, iaRatio: 0.2, inletK: 1.0, cnAdj: 0, recessH: 6 });
            buildHydroParams(); run();
        };
        $("btn-cal-log").onclick = function () { if (state.result) logCal(true); };
        renderCalLog();
    }

    function typedMax(a) {
        var m = -Infinity;
        for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
        return m;
    }

    function logCal(manual) {
        var res = state.result;
        var p = H.PARAMS;
        calLog.unshift({
            p: Object.assign({}, p),
            area: res.frames[res.frames.length - 1] ? typedMax(res.frames.map(function (f) { return f.areaKm2; })) : 0,
            maxD: res.hmax ? typedMax(res.hmax) : 0,
            pts: res.zones.length,
        });
        if (calLog.length > 8) calLog.pop();
        renderCalLog();
    }

    function renderCalLog() {
        var box = $("cal-log");
        if (!calLog.length) {
            box.innerHTML = '<p class="empty">改动参数后自动重算，点「记录本组」可比对效果</p>';
            return;
        }
        box.innerHTML = calLog.map(function (r, i) {
            return '<div class="cal-row" data-i="' + i + '">' +
                '<span class="hd">n=' + r.p.nMan + " dr=" + r.p.drainK + " st=" + r.p.storeK + "</span>" +
                "<span><b>" + fmt(r.maxD * 100, 0) + "</b>cm</span>" +
                "<span><b>" + fmt(r.area, 0) + "</b>km²</span></div>";
        }).join("");
        box.onclick = function (e) {
            var row = e.target.closest(".cal-row"); if (!row) return;
            H.setParams(calLog[+row.dataset.i].p);
            buildHydroParams(); run();
        };
    }

    // ============ 点位过程线 ============
    function initProbe() {
        state.map.on("click", function (e) {
            if (!state.result) return;
            probeAt(e.latlng.lat, e.latlng.lng);
        });
        $("probe-close").onclick = function () {
            $("probe").classList.add("hide");
            if (state.probeMarker) { state.map.removeLayer(state.probeMarker); state.probeMarker = null; }
            state.probeCell = null;
        };
    }

    function cellOf(lat, lon) {
        var d = state.dom, b = d.bbox, n = d.n;
        var i = Math.floor((lon - b[0]) / (b[2] - b[0]) * n);
        var j = Math.floor((b[3] - lat) / (b[3] - b[1]) * n);
        if (i < 0 || j < 0 || i >= n || j >= n) return -1;
        var k = j * n + i;
        return d.mask[k] ? k : -1;
    }

    function probeAt(lat, lon) {
        var k = cellOf(lat, lon);
        if (k < 0) { toast("该点不在市域计算域内"); return; }
        state.probeCell = { k: k, lat: lat, lon: lon };
        var d = state.dom, n = d.n;
        if (state.probeMarker) state.map.removeLayer(state.probeMarker);
        state.probeMarker = L.circleMarker([lat, lon], {
            radius: 5, color: "#fff", weight: 2, fillColor: "#00d3ff", fillOpacity: 1,
        }).addTo(state.map);
        $("probe").classList.remove("hide");
        $("probe-pos").textContent = fmt(lat, 4) + "°N , " + fmt(lon, 4) + "°E";
        $("probe-meta").textContent = "地面高程 " + fmt(d.z[k], 1) + " m · 不透水率 " + fmt(d.imperv[k] * 100, 0) +
            "% · 排水能力 " + fmt(d.drainMh[k], 0) + " mm/h · 汇流占比 " + fmt(d.accNorm[k] * 100, 0) + "%";
        drawProbe();
    }

    function probeSeries(k) {
        var res = state.result;
        var ts = [], hs = [], rs = [];
        var rainEnd = 0;   // 最后一帧仍在下雨的索引（之后为退水段）
        // 直接用点击格本身的水深：地图上色就是按单格值渲染的，
        // 过程线也必须同源，否则点击淹没区边缘时邻居的干格会把均值拉低，
        // 出现"地图深蓝但曲线几乎平的"矛盾（旧版 3×3 均值实测只剩 1/3~1/5）。
        for (var f = 0; f < res.frames.length; f++) {
            var fr = res.frames[f];
            ts.push(fr.t);
            hs.push(fr.depths[k] / 10);   // mm → cm
            rs.push(fr.rain);
            if (fr.rain > 0.01) rainEnd = f;
        }
        return { ts: ts, hs: hs, rs: rs, rainEnd: rainEnd };
    }

    function drawProbe() {
        if (!state.probeCell) return;
        var s = probeSeries(state.probeCell.k);
        var maxH = Math.max.apply(null, s.hs);
        var cumR = 0;
        for (var i = 0; i < s.rs.length; i++) cumR += s.rs[i] * (s.ts[1] - s.ts[0]);
        state.probeMax = cellMax; state.probeRain = cumR;
        // 该点过程最大（与地图 hmax 图层同源，可直接核对地图颜色；hmax 单位为 m）
        var k = state.probeCell.k;
        var cellMax = state.result.hmax ? state.result.hmax[k] * 100 : 0;   // m → cm
        var cur = s.hs[state.frameIdx] || 0;
        $("probe-foot").innerHTML = "过程最大积水 <b>" + fmt(cellMax, 1) + " cm</b> · 当前 <b>" +
            fmt(cur, 1) + " cm</b> · 累积降雨 <b>" + fmt(cumR, 0) + " mm</b><br>" +
            '<span class="pf-note">曲线为点击格实际水深（与地图着色同源）· 地面高程 ' + fmt(state.dom.z[k], 1) + " m</span>";

        if (!state.probeChart) {
            state.probeChart = echarts.init($("probe-chart"), null, { renderer: "canvas" });
        }
        // 纵轴自适应：按本点位实测水深定范围（不再被 15cm 阈值线/雨强撑开），
        // 留 25% 余量保证峰值上方有空隙；同时给出整齐的刻度步长。
        var hMax = Math.max(0.5, maxH);
        var yTop = hMax * 1.25;
        // 刻度取"好看"的步长：1/2/5/10/20/50 cm 中选，使刻度数 3~5 个
        var niceStep = 1;
        [1, 2, 5, 10, 20, 50, 100].some(function (st) {
            if (yTop / st <= 5) { niceStep = st; return true; }
            return false;
        });
        yTop = Math.ceil(yTop / niceStep) * niceStep;
        var rMax = Math.max.apply(null, s.rs) || 1;
        state.probeChart.setOption({
            backgroundColor: "transparent", animation: false,
            grid: { left: 32, right: 30, top: 12, bottom: 18 },
            tooltip: {
                trigger: "axis", backgroundColor: "rgba(6,22,36,.94)", borderColor: "rgba(0,195,255,.3)",
                textStyle: { color: "#d6ecf6", fontSize: 10 },
            },
            xAxis: {
                type: "category", boundaryGap: false,
                data: s.ts.map(function (t) { return fmt(t, 1); }),
                axisLine: { lineStyle: { color: "rgba(0,195,255,.2)" } }, axisTick: { show: false },
                axisLabel: { color: "#5d8ba1", fontSize: 8.5, interval: 11 },
            },
            yAxis: [
                {
                    type: "value", name: "cm", min: 0, max: yTop, interval: niceStep,
                    nameTextStyle: { color: "#4d7387", fontSize: 8 },
                    splitLine: { lineStyle: { color: "rgba(0,195,255,.07)" } },
                    axisLabel: { color: "#5d8ba1", fontSize: 8.5, margin: 2 },
                },
                {
                    type: "value", name: "雨强 mm/h", min: 0, max: Math.ceil(rMax / 0.55 / 10) * 10,
                    nameTextStyle: { color: "#4d7387", fontSize: 8 },
                    splitLine: { show: false }, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
                },
            ],
            series: [
                {
                    name: "雨强", type: "bar", yAxisIndex: 1, data: s.rs.map(function (v) { return +v.toFixed(1); }),
                    itemStyle: { color: "rgba(47,124,255,.45)" }, barWidth: "70%", z: 0,
                },
                {
                    name: "积水深度", type: "line", yAxisIndex: 0, smooth: true, symbol: "none",
                    data: s.hs.map(function (v) { return +v.toFixed(1); }),
                    lineStyle: { width: 1.8, color: "#00d3ff" },
                    areaStyle: { color: "rgba(0,211,255,.22)" },
                    markLine: {
                        silent: true, symbol: "none",
                        lineStyle: { color: "#ff6536", type: "dashed", width: 1 },
                        // 15cm 内涝阈值：仅当在本点位纵轴范围内才画，否则会把纵轴撑到 15cm
                        data: (15 <= yTop) ? [{
                            yAxis: 15,
                            label: { formatter: "内涝 15cm", color: "#ff6536", fontSize: 8, position: "end" },
                        }] : [],
                    },
                },
                // 峰值标记：一眼看出该点最大水深
                {
                    name: "峰值", type: "scatter", yAxisIndex: 0, symbolSize: 7,
                    data: [[s.hs.indexOf(maxH), +maxH.toFixed(1)]],
                    itemStyle: { color: "#ffd479", borderColor: "#04121f", borderWidth: 1 },
                    label: {
                        show: true, position: "top", color: "#ffd479", fontSize: 8.5,
                        formatter: function (p) { return fmt(p.value[1], 1) + " cm"; },
                    },
                },
            ],
        }, true);
        state.probeChart.resize();
        $("probe-foot").innerHTML = "过程最大积水 <b>" + fmt(maxH, 1) + " cm</b> · 累积降雨 <b>" +
            fmt(cumR, 0) + " mm</b> · 当前 <b>" + fmt(s.hs[state.frameIdx] || 0, 1) + " cm</b>";
    }

    // ============ 融合校核模块桥接（js/fusion.js 使用） ============
    window.__FB = {
        state: state, run: run, scenario: scenario,
        rebuildHydroParams: function () { try { buildHydroParams(); } catch (e) { } },
        toast: toast,
    };

    // ============ 启动 ============
    document.addEventListener("DOMContentLoaded", function () {
        init();
        $("lab-f").textContent = "1.00 ×";
        buildMLParams();
        buildHydroParams();
        initProbe();
    });

    // ---------- ML 参数 ----------
    function buildMLParams() {
        if (!ML) return;
        var algo = state.algo;
        var defs = ML.ALGOS[algo];
        if (!defs) return;
        var box = $("ml-params");
        var params = state.mlParams[algo] || (state.mlParams[algo] = ML.defaultParams(algo));
        var html = "";
        (defs.params || []).forEach(function (p) {
            var v = params[p.key] !== undefined ? params[p.key] : p.value;
            params[p.key] = v;
            html += '<div class="mp"><div class="lab"><span>' + p.label + "</span><b>" + v + "</b></div>" +
                '<input type="range" class="rng" data-k="' + p.key + '" min="' + p.min + '" max="' + p.max +
                '" step="' + p.step + '" value="' + v + '"></div>';
        });
        box.innerHTML = html || '<p class="tip">该算法无额外可调参数</p>';
        box.querySelectorAll("input[type=range]").forEach(function (inp) {
            inp.addEventListener("input", function () {
                params[this.dataset.k] = +this.value;
                this.parentNode.querySelector(".lab b").textContent = this.value;
            });
            inp.addEventListener("change", function () { markDirty(); });
        });
    }
})();
