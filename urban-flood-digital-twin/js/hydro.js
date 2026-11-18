/* ============================================================
   城市内涝水动力过程引擎 (HydroDT)
   ------------------------------------------------------------
   v1.0  ·  真实行政边界 + 真实 DEM 的二维漫流演算
   ------------------------------------------------------------
   模型结构（类 LISFLOOD-FP / MIKE 21 简化思路，非官方实现）：
     1. 计算域：城市行政边界内 224×224 正交网格，DEM 双线性采样
     2. 产流：SCS-CN 累积曲线法（前期损失 Ia，按不透水率分区取 CN）
     3. 排水：管网排水能力按覆盖度折减，作为逐格汇项
     4. 漫流：Manning 明渠公式逐边通量（4 邻域，显式体积守恒）
              q = (1/n)·h^(5/3)·sqrt(∂W/∂x)·Δx ,  W = z + h
              通量限幅 0.45·h·Δx² 保证稳定性
     5. 河湖：汇流累积量高且坡度极缓的格子作为定水位边界（外排口）
     6. 输出：逐帧水深场（Uint16 毫米量化）+ 逐帧水文统计
   评估：内涝问题点提取（连通域）、积水成因诊断、H-E-V 风险指数
   ============================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Hydro = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var POND = 0.15;               // 15cm 计为内涝
    var N_MAN = 0.045;             // 城市综合糙率（默认值）
    // 8 邻域偏移：前 4 个为正交，后 4 个为对角（便于只取 4 邻时截断）
    var NB_I = [1, -1, 0, 0, 1, 1, -1, -1];
    var NB_J = [0, 0, 1, -1, 1, -1, 1, -1];
    var NB_L = [1, 1, 1, 1, 1.41421356, 1.41421356, 1.41421356, 1.41421356];
    // 复用的临时数组（避免每步分配，减小 GC 抖动）
    var NB_K = new Int32Array(8);
    var NB_W = new Float64Array(8);
    // ---- 可率定参数（前端可调）----
    var PARAMS = {
        nMan: 0.045,      // 综合糙率 Manning n：越大漫流越慢、积水越集中
        drainK: 0.45,     // 管网系统过水折减（淤积、混接、干管顶托、泵站能力）
        storeK: 1.00,     // 洼蓄/截留系数（乘在基础洼蓄上）
        iaRatio: 0.20,    // 初损系数 Ia/S
        inletK: 1.00,     // 雨水口进水效率
        outfallK: 1.00,   // 边界自由出流系数
        cnAdj: 0.00,      // CN 修正量（-8 ~ +8）
        recessH: 6.0,     // 洼地退水时间常数（h）：强排/泵站、下渗与蒸发
        slaMin: 0.0015,   // 街道系统最小有效水力梯度（城市地表输水能力）
    };
    function setParams(p) {
        for (var k in p) if (PARAMS.hasOwnProperty(k) && p[k] !== undefined) PARAMS[k] = +p[k];
        return PARAMS;
    }
    var RISK_LEVELS = [
        { key: "extreme", name: "极高", color: "#ff2b4d", min: 50 },
        { key: "high", name: "高", color: "#ff6536", min: 42 },
        { key: "medium_high", name: "中高", color: "#ff9820", min: 34 },
        { key: "medium", name: "中", color: "#ffd247", min: 26 },
        { key: "monitor", name: "低", color: "#22c55e", min: 0 },
    ];
    var CAUSES = {
        low_lying: { name: "低洼汇水", hint: "地势低洼、上游汇水集中" },
        drainage_short: { name: "管网能力不足", hint: "排水标准低于暴雨强度" },
        impervious: { name: "不透水面过高", hint: "硬化率高、径流系数大" },
        river_backwater: { name: "河道顶托", hint: "临河外水位高，自排不畅" },
        flat_terrain: { name: "地形平坦外排慢", hint: "坡降极小，退水历时长" },
    };

    // ---------------- 基础 ----------------
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }

    function hashString(s) {
        var h = 2166136261 >>> 0;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        return h >>> 0;
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

    function b64ToBuf(str) {
        var bin;
        if (typeof atob === "function") {
            bin = atob(str);
        } else {
            bin = Buffer.from(str, "base64").toString("binary");
        }
        var len = bin.length;
        var buf = new ArrayBuffer(len);
        var u8 = new Uint8Array(buf);
        for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        return buf;
    }

    function b64ToInt16(str) {
        return new Int16Array(b64ToBuf(str));
    }

    // DEM 解码：早期数据是「绝对高程 Q10 有符号 int16」，上限 ±3276.7 m，
    // 拉萨（3650 m）、滇西北山区这类高海拔域会被截断成平台。
    // 新数据改存「相对基准高程的 Q10 无符号 uint16」并带上 z0 偏移：
    //   elev = q/10 + z0        z0 = floor(min/100)*100
    // 量程 0~6553 m、精度仍 0.1 m，覆盖全国所有城市及其周边山地。
    // 没有 z0 字段的旧文件自动走 int16 老路径，不需要重建既有数据。
    function demElev(dem) {
        if (dem._elev) return dem._elev;
        var buf = b64ToBuf(dem.q);
        var arr = dem.z0 === undefined ? new Int16Array(buf) : new Uint16Array(buf);
        dem._elev = { a: arr, z0: dem.z0 === undefined ? 0 : dem.z0 };
        return dem._elev;
    }

    // ---------------- 暴雨 ----------------
    // GB 50014 暴雨强度公式  q = 167A(1+Clgp)/(t+b)^n  [L/(s·ha)] → mm/h
    function idf(storm, T, durMin) {
        var p = Math.max(0.3, T), t = Math.max(5, durMin);
        var q = 167 * storm.A * (1 + storm.C * Math.log10(p)) / Math.pow(t + storm.b, storm.n);
        return q * 0.36;
    }

    // 单峰雨型（峰值位置 0.42，前后不对称）
    function patternWeights(nSteps, peakAt, skew) {
        var w = [], sum = 0;
        for (var i = 0; i < nSteps; i++) {
            var x = (i + 0.5) / nSteps;
            var s = x < peakAt ? peakAt * skew : (1 - peakAt);
            var v = Math.exp(-Math.pow((x - peakAt) / (s * 0.36), 2)) + 0.1;
            w.push(v); sum += v;
        }
        for (var k = 0; k < w.length; k++) w[k] /= sum;
        return w;
    }

    /**
     * 生成降雨过程（mm/h，逐模拟步），含退水段（0 降雨）
     * cfg: {totalMm, durationH, recedeH, steps, pattern}
     */
    function makeRain(cfg) {
        var durH = cfg.durationH, recH = cfg.recedeH;
        var S = cfg.steps;
        var nRain = Math.max(4, Math.round(S * durH / (durH + recH)));
        var w = patternWeights(nRain, cfg.peakAt || 0.42, cfg.skew || 1.7);
        var out = new Float32Array(S);
        var filled = 0, acc = 0;
        for (var i = 0; i < nRain; i++) {
            var mm = cfg.totalMm * w[i];
            // 该步长（小时）
            var dtH = (durH / nRain);
            var intensity = mm / Math.max(1e-6, dtH);
            out[i] = intensity;
            acc += mm; filled++;
        }
        return { series: out, rainSteps: nRain, total: acc, peak: Math.max.apply(null, Array.prototype.slice.call(out, 0, nRain)) };
    }

    // ---------------- 域构建 ----------------
    function pointInRings(rings, x, y) { /* 保留接口，实际用扫描线 */ return false; }

    // 扫描线填充（even-odd），同时支持多个环
    function fillMask(rings, n, bbox) {
        var w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
        var mask = new Uint8Array(n * n);
        var edges = [];
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r];
            for (var i = 0; i < ring.length; i++) {
                var a = ring[i], b = ring[(i + 1) % ring.length];
                if (a[1] === b[1]) continue;
                edges.push([a[0], a[1], b[0], b[1]]);
            }
        }
        var xs = new Float64Array(edges.length);
        for (var j = 0; j < n; j++) {
            var lat = bbox[3] - (j + 0.5) / n * h;
            var m = 0;
            for (var e = 0; e < edges.length; e++) {
                var ed = edges[e];
                if ((ed[1] <= lat && ed[3] > lat) || (ed[3] <= lat && ed[1] > lat)) {
                    var t = (lat - ed[1]) / (ed[3] - ed[1]);
                    xs[m++] = ed[0] + t * (ed[2] - ed[0]);
                }
            }
            if (!m) continue;
            var arr = Array.prototype.slice.call(xs, 0, m).sort(function (p, q) { return p - q; });
            for (var k = 0; k + 1 < arr.length; k += 2) {
                var i0 = Math.round((arr[k] - bbox[0]) / w * n);
                var i1 = Math.round((arr[k + 1] - bbox[0]) / w * n);
                i0 = clamp(i0, 0, n - 1); i1 = clamp(i1, 0, n - 1);
                for (var ii = i0; ii <= i1; ii++) mask[j * n + ii] = 1;
            }
        }
        return mask;
    }

    function sampleDEM(dem, bbox, n) {
        var dn = dem.n, db = dem.bbox;
        var de = demElev(dem), q = de.a, z0 = de.z0;
        var out = new Float32Array(n * n);
        var spanX = db[2] - db[0], spanY = db[3] - db[1];
        for (var j = 0; j < n; j++) {
            var lat = bbox[3] - (j + 0.5) / n * (bbox[3] - bbox[1]);
            // DEM 栅格行序为「北 → 南」（行 0 是最北一行），必须用 db[3] 减纬度，
            // 否则整个地形会南北镜像（市区被读成北部山区高程）。
            var fy = (db[3] - lat) / spanY * (dn - 1);
            fy = clamp(fy, 0, dn - 1.001);
            var y0 = Math.floor(fy), ty = fy - y0;
            for (var i = 0; i < n; i++) {
                var lon = bbox[0] + (i + 0.5) / n * (bbox[2] - bbox[0]);
                var fx = (lon - db[0]) / spanX * (dn - 1);
                fx = clamp(fx, 0, dn - 1.001);
                var x0 = Math.floor(fx), tx = fx - x0;
                var v00 = q[y0 * dn + x0], v10 = q[y0 * dn + x0 + 1];
                var v01 = q[(y0 + 1) * dn + x0], v11 = q[(y0 + 1) * dn + x0 + 1];
                var v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
                out[j * n + i] = v / 10 + z0;
            }
        }
        return out;
    }

    /**
     * 3×3 均值平滑（原地，迭代 pass 次），仅对 mask 内格子
     * 目的：压掉 DEM 的高频噪声，避免把噪声当洼地
     */
    function smoothZ(z, mask, n, pass) {
        var tmp = new Float32Array(z.length);
        for (var p = 0; p < pass; p++) {
            for (var j = 0; j < n; j++) {
                for (var i = 0; i < n; i++) {
                    var k = j * n + i;
                    if (!mask[k]) { tmp[k] = z[k]; continue; }
                    var s = 0, c = 0;
                    for (var dj = -1; dj <= 1; dj++) {
                        var jj = j + dj; if (jj < 0 || jj >= n) continue;
                        for (var di = -1; di <= 1; di++) {
                            var ii = i + di; if (ii < 0 || ii >= n) continue;
                            var kk = jj * n + ii;
                            if (!mask[kk]) continue;
                            s += z[kk]; c++;
                        }
                    }
                    tmp[k] = c ? s / c : z[k];
                }
            }
            z.set(tmp);
        }
        return z;
    }

    /**
     * 优先泛洪（priority-flood）填洼，返回每格洼地深度 = 填后高程 − 原高程（m）
     * 边界格作为出口。堆实现，O(N log N)，5 万格约 20 ms。
     */
    function fillSinks(z, mask, n) {
        var N = z.length;
        var filled = new Float32Array(N);
        var done = new Uint8Array(N);
        var hz = [], hi = [];              // 二叉堆（最小堆）
        function push(v, k) {
            hz.push(v); hi.push(k);
            var c = hz.length - 1;
            while (c > 0) {
                var pa = (c - 1) >> 1;
                if (hz[pa] <= hz[c]) break;
                var tv = hz[pa]; hz[pa] = hz[c]; hz[c] = tv;
                var tk = hi[pa]; hi[pa] = hi[c]; hi[c] = tk;
                c = pa;
            }
        }
        function pop() {
            var top = hi[0], outV = hz[0];
            var lastV = hz.pop(), lastK = hi.pop();
            if (hz.length) {
                hz[0] = lastV; hi[0] = lastK;
                var c = 0, L = hz.length;
                for (;;) {
                    var l = c * 2 + 1, r = l + 1, sm = c;
                    if (l < L && hz[l] < hz[sm]) sm = l;
                    if (r < L && hz[r] < hz[sm]) sm = r;
                    if (sm === c) break;
                    var tv = hz[sm]; hz[sm] = hz[c]; hz[c] = tv;
                    var tk = hi[sm]; hi[sm] = hi[c]; hi[c] = tk;
                    c = sm;
                }
            }
            return [outV, top];
        }
        // 种子：mask 边界
        for (var j = 0; j < n; j++) {
            for (var i = 0; i < n; i++) {
                var k = j * n + i;
                if (!mask[k]) continue;
                if (i === 0 || j === 0 || i === n - 1 || j === n - 1 ||
                    !mask[k - 1] || !mask[k + 1] || !mask[k - n] || !mask[k + n]) {
                    filled[k] = z[k]; done[k] = 1; push(z[k], k);
                }
            }
        }
        var nb4 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        while (hz.length) {
            var w = pop(), zb = w[0], kb = w[1];
            var bj = (kb / n) | 0, bi = kb % n;
            for (var d = 0; d < 8; d++) {
                var ni = bi + nb4[d][0], nj = bj + nb4[d][1];
                if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
                var kn = nj * n + ni;
                if (!mask[kn] || done[kn]) continue;
                done[kn] = 1;
                filled[kn] = Math.max(z[kn], zb);
                push(filled[kn], kn);
            }
        }
        var dep = new Float32Array(N);
        for (var m = 0; m < N; m++) if (mask[m]) dep[m] = Math.max(0, filled[m] - z[m]);
        return dep;
    }

    /**
     * 构建计算域
     * city: data/cities.json 中的城市对象
     * geo:  data/geo/<id>.json
     * dem:  data/dem/<id>.json
     */
    function buildDomain(city, geo, dem, opt) {
        opt = opt || {};
        var n = opt.n || 224;
        var b, padX, padY;
        if (opt.sizeKm) {
            // 主城区窗口：以市中心为原点取 sizeKm × sizeKm 正方形
            // 注意：必须用城市中心坐标，不能用行政边界质心 —— 北京这类市域的
            // 质心在北部山区（约 40.19°N），会把窗口开到怀柔、完全错过主城区。
            var c = (city.lat && city.lon) ? [city.lon, city.lat] : (city.center || geo.center);
            var halfLat = (opt.sizeKm / 2) / 110.54;
            var halfLon = (opt.sizeKm / 2) / (111.32 * Math.cos(c[1] * Math.PI / 180));
            b = [c[0] - halfLon, c[1] - halfLat, c[0] + halfLon, c[1] + halfLat];
            padX = 0; padY = 0;
        } else {
            b = city.bbox_real;
            padX = (b[2] - b[0]) * 0.035; padY = (b[3] - b[1]) * 0.035;
        }
        var bbox = [b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY];

        var midLat = (bbox[1] + bbox[3]) / 2;
        var mPerDegLon = 111320 * Math.cos(midLat * Math.PI / 180);
        var mPerDegLat = 110540;
        var dx = ((bbox[2] - bbox[0]) * mPerDegLon) / n;
        var dy = ((bbox[3] - bbox[1]) * mPerDegLat) / n;
        var dxm = (dx + dy) / 2;

        var z = sampleDEM(dem, bbox, n);
        var mask = fillMask(geo.rings, n, bbox);

        var N = n * n;
        var rnd = mulberry32(hashString(city.id + "|domain"));

        // --- DEM 轻微平滑 + 填洼，得到「真实洼地深度」depress
        // 200 m 级网格上的洼地蓄水是城市内涝的主要载体：雨水先充满洼地，
        // 溢出后才形成漫流。没有这一步，二维漫流会把降雨摊成一层均匀薄膜。
        smoothZ(z, mask, n, 2);
        var depress = fillSinks(z, mask, n);   // 单位 m

        // --- 坡度
        var slope = new Float32Array(N);
        for (var j = 1; j < n - 1; j++) {
            for (var i = 1; i < n - 1; i++) {
                var k = j * n + i;
                var dzdx = (z[k + 1] - z[k - 1]) / (2 * dxm);
                var dzdy = (z[k + n] - z[k - n]) / (2 * dxm);
                slope[k] = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
            }
        }

        // --- D8 汇流累积
        var order = [];
        for (var p = 0; p < N; p++) if (mask[p]) order.push(p);
        order.sort(function (a2, b2) { return z[b2] - z[a2]; });
        var acc = new Float32Array(N);
        var dirI = new Int32Array(N);          // 最陡下降目标格（-1 = 无下游/出口）
        for (var q3 = 0; q3 < N; q3++) dirI[q3] = -1;
        for (var q2 = 0; q2 < N; q2++) if (mask[q2]) acc[q2] = 1;
        var nb = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
        for (var oi = 0; oi < order.length; oi++) {
            var ci = order[oi], cj = (ci / n) | 0, cii = ci % n;
            var best = -1, bestS = 0;
            for (var k2 = 0; k2 < 8; k2++) {
                var ni = cii + nb[k2][0], nj = cj + nb[k2][1];
                if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
                var t2 = nj * n + ni;
                if (!mask[t2]) continue;
                var drop = z[ci] - z[t2];
                if (drop <= 0) continue;
                var dist = (nb[k2][0] !== 0 && nb[k2][1] !== 0) ? dxm * 1.4142 : dxm;
                var s2 = drop / dist;
                if (s2 > bestS) { bestS = s2; best = t2; }
            }
            dirI[ci] = best;
            if (best >= 0) acc[best] += acc[ci];
        }
        var totalCells = order.length;
        var accNorm = new Float32Array(N);
        for (var a3 = 0; a3 < N; a3++) {
            accNorm[a3] = mask[a3] ? clamp(Math.log(1 + acc[a3]) / Math.log(1 + totalCells * 0.35), 0, 1) : 0;
        }

        // --- 河湖识别：汇流量大 + 坡度极缓 + 低高程（含海域/滩涂）
        var water = new Uint8Array(N);
        var zSorted = [];
        for (var w1 = 0; w1 < N; w1++) if (mask[w1]) zSorted.push(z[w1]);
        zSorted.sort(function (a4, b4) { return a4 - b4; });
        var zLow = zSorted[Math.floor(zSorted.length * 0.22)];
        // 汇流量分位数（取前 6% 作为主河道 + 支流）
        var accList = [];
        for (var q1 = 0; q1 < N; q1++) if (mask[q1]) accList.push(accNorm[q1]);
        accList.sort(function (a5, b5) { return b5 - a5; });
        var accCut = accList[Math.floor(accList.length * 0.060)] || 0.9;
        for (var w2 = 0; w2 < N; w2++) {
            if (!mask[w2]) continue;
            if (z[w2] < 0.6) { water[w2] = 1; z[w2] = Math.max(z[w2], 0.4); continue; }
            if (accNorm[w2] >= accCut && slope[w2] < 0.022) water[w2] = 1;
            else if (z[w2] <= zLow && slope[w2] < 0.0042 && accNorm[w2] > 0.5) water[w2] = 1;
        }

        // --- 城市化强度：中心距离高斯 + 地形平坦度 + 随机纹理
        // 中心必须取市中心（city.lat/lon），不能用行政边界质心：北京质心在北部
        // 山区，落在主城区窗口之外，会把整个城区的城市化强度算成郊区值。
        var uc = (city.lat && city.lon) ? [city.lon, city.lat] : (city.center || geo.center);
        var cx = (uc[0] - bbox[0]) / (bbox[2] - bbox[0]) * n;
        var cy = (bbox[3] - uc[1]) / (bbox[3] - bbox[1]) * n;
        var urban = new Float32Array(N);
        var sigma = n * 0.42;
        for (var u = 0; u < N; u++) {
            var ui = u % n, uj = (u / n) | 0;
            var d = Math.sqrt((ui - cx) * (ui - cx) + (uj - cy) * (uj - cy));
            var g = Math.exp(-Math.pow(d / sigma, 2));
            var flat = 1 - clamp(slope[u] / 0.02, 0, 1);
            var nz = (Math.sin(ui * 0.31 + uj * 0.17) + Math.sin(ui * 0.07 - uj * 0.23)) * 0.06;
            urban[u] = mask[u] ? clamp(0.12 + 0.74 * g * (0.55 + 0.45 * flat) + nz, 0, 1) : 0;
        }

        // --- 建成区基准高程：用于剔除山体沟谷里的"假积水"
        var ucZ = [];
        for (var uz = 0; uz < N; uz++) if (mask[uz] && urban[uz] > 0.55) ucZ.push(z[uz]);
        ucZ.sort(function (a, b) { return a - b; });
        var zUrban = ucZ.length ? ucZ[Math.floor(ucZ.length * 0.5)] : 0;
        var zCap = zUrban + 95;      // 高于建成区中位高程 95 m 以上视为山丘，不做内涝评价

        // --- 属性
        var imperv = new Float32Array(N);
        var cn = new Float32Array(N);
        var drainCap = new Float32Array(N);   // mm/h → m/s
        var drainMh = new Float32Array(N);    // 记录原始 mm/h
        var dstore = new Float32Array(N);     // 洼蓄/滞留水深 (m)，低于此值不参与漫流
        var soil = city.soil || "C";
        var soilCN = { A: 61, B: 75, C: 83, D: 87 }[soil] || 83;
        var cov = clamp(city.drain.coverage * 100, 0, 100) / 100;
        for (var at = 0; at < N; at++) {
            if (!mask[at]) continue;
            var im = water[at] ? 0.03 : clamp(0.16 + 0.78 * urban[at] * urban[at] + 0.05 * rnd(), 0.05, 0.96);
            imperv[at] = im;
            cn[at] = water[at] ? 98 : clamp(soilCN + (98 - soilCN) * im * 0.85, 45, 98);
            var localCov = clamp(cov * (0.85 + 0.15 * urban[at]), 0, 1);
            // 现状管网过水能力 ≈ 设计标准 × 覆盖率 × 运行折减（淤积、混接）
            var cap = city.drain.capacity_mm_h * 0.88 * localCov;
            cap *= (1 - 0.40 * clamp((accNorm[at] - 0.35) / 0.65, 0, 1));   // 临河顶托
            // 洼地内进水口被淹/被顶托，排水效率大幅下降 —— 这是内涝积水的直接成因
            var pondW = clamp(depress[at] / 1.0, 0, 1);
            cap *= (1 - 0.72 * pondW);
            cap = clamp(cap, 0, 90);
            drainMh[at] = water[at] ? 0 : cap;
            drainCap[at] = cap / 1000 / 3600;
            // 洼蓄 = max(地面滞蓄, 地形洼地深度)
            // 前者是硬化/绿地的表面滞水（城市化区 ~1 cm、郊区 ~3.5 cm），属于产流初损；
            // 后者才是洼地真正的蓄水能力（可达 1.9 m）。漫流只搬运洼蓄以上的水，
            // 因此洼地会存水成塘，而绝大部分平地只留一两厘米的薄水膜（不再出现全城 5 cm 假水面）。
            var dsBase = 0.008 + 0.028 * (1 - im);
            // 洼地深度先扣掉 25 cm 的"噪声底"：179 m 网格上填洼得到的浅坑多半是
            // 道路边沟、田埂、DEM 噪声，真蓄水的是更深的洼地，否则地图上会撒满
            // 大小一样的小水洼，看不出真正的内涝片区。
            var dsDep = Math.min(1.9, Math.max(0, depress[at] - 0.25) * 0.85);
            // 易涝节点：下穿隧道、立交低点、地下通道等——这类内涝主战场在
            // 200 m 级 DEM 上完全看不出来，按建成区比例参数化。关键是只放在
            // 汇流集中的低洼带上（accNorm 高），否则全城均匀撒点，图上会出现
            // 到处都是一模一样的小水洼，失去"哪里真淹"的意义。
            if (urban[at] > 0.45 && accNorm[at] > 0.72 && rnd() < 0.022) dsDep = Math.max(dsDep, 0.30 + 0.50 * rnd());
            // 山区/丘陵不在城市内涝评价范围内：其汇流是山洪/河道过程，不属于本模型。
            // 若照地形洼地存水，地图上会在西山沟谷里出现一堆"山塘"，误导判断。
            // 注意：衰减必须放在易涝节点赋值之后，否则又会被重新抬起来。
            var hillF = clamp(1 - (z[at] - zCap) / 40, 0, 1);
            dsDep *= clamp(urban[at] * 3.2, 0.08, 1) * hillF;
            dstore[at] = water[at] ? 0 : Math.max(dsBase, dsDep);

        }

        // --- 亚网格洼地集中系数
        // 网格尺度（200~800 m）无法分辨街道与局部洼地，二维漫流会把降雨摊成一层
        // 均匀薄膜。引入「有效积水面积比」w：汇流越集中（accNorm 越大），实际滞水
        // 面积占网格面积的比例越小，网格内等效水深 = 体积 / (w·A)。
        // 该处理是标准的亚网格参数化，不改变水量平衡（排水/出流仍按真实体积计算）。
        var wconc = new Float32Array(N);
        for (var wc = 0; wc < N; wc++) {
            if (!mask[wc]) { wconc[wc] = 1; continue; }
            var a = accNorm[wc];
            wconc[wc] = clamp(1.0 - 0.26 * a, 0.6, 1.0);
        }

        // --- 边界出流格（自由出流）
        var edge = new Uint8Array(N);
        for (var ej = 0; ej < n; ej++) {
            for (var ei = 0; ei < n; ei++) {
                var ek = ej * n + ei;
                if (!mask[ek]) continue;
                var isEdge = (ei === 0 || ej === 0 || ei === n - 1 || ej === n - 1);
                if (!isEdge) {
                    if (!mask[ek - 1] || !mask[ek + 1] || !mask[ek - n] || !mask[ek + n]) isEdge = true;
                }
                if (isEdge) edge[ek] = 1;
            }
        }

        return {
            n: n, N: N, bbox: bbox, dx: dxm, cellArea: dxm * dxm,
            z: z, mask: mask, water: water, slope: slope, acc: acc, accNorm: accNorm,
            depress: depress, dir: dirI, order: order,
            urban: urban, imperv: imperv, cn: cn, drainCap: drainCap, drainMh: drainMh,
            dstore: dstore, edge: edge, wconc: wconc,
            cellKm: dxm / 1000, city: city, geo: geo,
        };
    }

    // ---------------- 演算 ----------------
    /**
     * cfg: {totalMm, durationH, recedeH, steps, frameEvery, peakAt, skew}
     */
    function runSim(dom, cfg) {
        var n = dom.n, N = dom.N;
        var z = dom.z, mask = dom.mask, water = dom.water, cn = dom.cn,
            drainCap = dom.drainCap, cellArea = dom.cellArea, dx = dom.dx, dstore = dom.dstore, edge = dom.edge,
            urban = dom.urban, wconc = dom.wconc;
        var PR = Object.assign({}, PARAMS, cfg.params || {});
        var nMan = Math.max(0.012, PR.nMan);
        var dsK = PR.storeK, drainK = PR.drainK, inletK = PR.inletK, outK = PR.outfallK;
        var SLA_MIN = Math.max(0.0002, PR.slaMin || 0.0015);
        var steps = cfg.steps || 420;
        var frameEvery = cfg.frameEvery || 6;
        var totalT = (cfg.durationH + cfg.recedeH) * 3600;
        var dt = totalT / steps;

        var rain = makeRain({ totalMm: cfg.totalMm, durationH: cfg.durationH, recedeH: cfg.recedeH, steps: steps, peakAt: cfg.peakAt, skew: cfg.skew });

        var h = new Float32Array(N);
        var V = new Float32Array(N);     // 每格水量（m³），汇流级联用
        var ord = dom.order, dir = dom.dir;
        var FR = new Float32Array(N);    // 东向边通量 (k → k+1) m³
        var FD = new Float32Array(N);    // 南向边通量 (k → k+n) m³
        var hmax = new Float32Array(N);
        var Pcum = new Float32Array(N);
        var Qprev = new Float32Array(N);
        var Ia = new Float32Array(N);
        var S5 = new Float32Array(N);
        for (var s0 = 0; s0 < N; s0++) {
            var cnv = Math.max(40, Math.min(98, cn[s0] + PR.cnAdj));
            var S = 25400 / cnv - 254;
            S5[s0] = 0.8 * S;
            Ia[s0] = PR.iaRatio * S;
        }

        var frames = [];
        var outfall = 0;
        var t0 = now();
        var hmaxAll = 0;

        for (var st = 0; st < steps; st++) {
            var rate = rain.series[st];     // mm/h
            var Pmm = rate * dt / 3600;     // 本步降雨量 mm

            // (1) 产流 + 管网排水
            for (var k = 0; k < N; k++) {
                if (!mask[k]) continue;
                if (water[k]) { h[k] = 0; continue; }
                if (Pmm > 0) {
                    Pcum[k] += Pmm;
                    var Qcum = Pcum[k] > Ia[k] ? (Pcum[k] - Ia[k]) * (Pcum[k] - Ia[k]) / (Pcum[k] + S5[k]) : 0;
                    var dQ = Qcum - Qprev[k];
                    if (dQ > 0) { Qprev[k] = Qcum; h[k] += dQ / 1000; }
                }
                var dr = drainCap[k] * drainK * inletK * dt;
                if (dr > 0) {
                    // 进水口淹没时效率略降（不超过 35%），避免形成失控正反馈
                    if (h[k] > 0.30) dr *= 0.65;
                    h[k] = h[k] > dr ? h[k] - dr : 0;
                }
            }

            // (2) 汇流：沿下游多向分配（fill-and-spill 级联 + 多向漫流）
            // 200 m 网格上平坦城区的水面几乎水平，二维漫流几乎没有驱动力，水
            // 到不了洼地，只会摊成一层均匀薄膜。城市地表实际汇流由街道—边沟—
            // 管道系统完成，这里用「填洼—溢流」级联演算：每格先蓄满自己的洼蓄
            // 容量，超过部分按下坡坡度权重分配给所有更低邻格——单向下游（D8）
            // 会让水在地图上变成一格宽的"蓝色细线"，多向分配才能形成有面
            // 积的积水片。纯水量守恒。
            for (var v0 = 0; v0 < N; v0++) V[v0] = h[v0] * cellArea;
            var of = 0;
            for (var oi2 = 0; oi2 < ord.length; oi2++) {
                var k3 = ord[oi2];
                if (!mask[k3]) continue;
                if (water[k3]) { of += V[k3]; V[k3] = 0; continue; }
                var capV = dstore[k3] * dsK * cellArea;
                var avail = V[k3];
                if (avail <= capV) continue;
                var pass = avail - capV;
                V[k3] = capV;
                // --- 多向分配：找所有更低邻格，按坡度加权
                var i3 = k3 % n, j3 = (k3 / n) | 0, zk = z[k3];
                var sumW = 0, nbN = 0;
                for (var dd = 0; dd < 8; dd++) {
                    var mi = i3 + NB_I[dd], mj = j3 + NB_J[dd];
                    if (mi < 0 || mi >= n || mj < 0 || mj >= n) continue;
                    var kk = mj * n + mi;
                    if (!mask[kk] || water[kk]) continue;
                    var dz = zk - z[kk];
                    if (dz <= 0) continue;
                    var wq = dz / NB_L[dd];
                    NB_K[nbN] = kk; NB_W[nbN] = wq; sumW += wq; nbN++;
                }
                if (nbN === 0) { of += pass; continue; }     // 无下游 → 边界出口
                for (var q4 = 0; q4 < nbN; q4++) V[NB_K[q4]] += pass * NB_W[q4] / sumW;
            }
            for (var v1 = 0; v1 < N; v1++) h[v1] = mask[v1] ? V[v1] / cellArea : 0;

            // (2b) 水面坦化：把洼地里的水摊到同一水平面
            // 否则多向分配仍会沿单条深槽堆起一格宽的"水脊"。这里做一次纯守恒的
            // 邻格间调平（水面高程 z+h 高的一侧流向低的一侧），让积水形成有面积
            // 的水塘而不是细线。
            for (var it = 0; it < 2; it++) {
                for (var lk = 0; lk < ord.length; lk++) {
                    var k5 = ord[lk];
                    if (!mask[k5] || water[k5]) continue;
                    var hk = h[k5];
                    if (hk <= 0.05) continue;            // 只调平已成塘的水，不动薄层漫流
                    var wsK = z[k5] + hk, i5 = k5 % n, j5 = (k5 / n) | 0;
                    for (var d5 = 0; d5 < 4; d5++) {
                        var ni5 = i5 + NB_I[d5], nj5 = j5 + NB_J[d5];
                        if (ni5 < 0 || ni5 >= n || nj5 < 0 || nj5 >= n) continue;
                        var kn = nj5 * n + ni5;
                        if (!mask[kn] || water[kn]) continue;
                        var diff = wsK - (z[kn] + h[kn]);
                        if (diff <= 1e-4) continue;
                        var dv = 0.22 * diff;                // 渐进调平，避免一步抽干
                        if (dv > h[k5] * 0.5) dv = h[k5] * 0.5;
                        h[k5] -= dv; h[kn] += dv;
                        hk = h[k5]; wsK = z[k5] + hk;
                        if (hk <= 0.05) break;
                    }
                }
            }

            // (3) 洼地退水（强排/泵站、下渗与蒸发）
            // 积水深度 5 cm 以上的部分按 recessH 时间常数衰减，形成真实的退水过程线
            var rec = Math.exp(-dt / (Math.max(0.5, PR.recessH) * 3600));
            for (var v2 = 0; v2 < N; v2++) {
                if (!mask[v2] || water[v2]) continue;
                if (h[v2] > 0.05) h[v2] = 0.05 + (h[v2] - 0.05) * rec;
            }

            outfall += of;

            // (5) 记录
            if (st % frameEvery === frameEvery - 1 || st === steps - 1) {
                var q16 = new Uint16Array(N);
                var area = 0, sumD = 0, maxD = 0, vol = 0, cnt = 0, c2 = 0, c5 = 0, a2 = 0, a5 = 0;
                for (var m = 0; m < N; m++) {
                    var hh = h[m] / wconc[m];
                    if (hh > 3) hh = 3;
                    if (hh > hmax[m]) hmax[m] = hh;
                    if (hh > hmaxAll) hmaxAll = hh;
                    q16[m] = hh > 65.535 ? 65535 : Math.round(hh * 1000);
                    if (hh >= POND) { cnt++; area += cellArea; sumD += hh; if (hh > maxD) maxD = hh; }
                    if (hh >= 0.02) { c2++; a2 += cellArea; }
                    if (hh >= 0.05) { c5++; a5 += cellArea; }
                    vol += h[m] * cellArea;
                }
                frames.push({
                    t: (st + 1) * dt / 3600,
                    rain: rate,
                    depths: q16,
                    areaKm2: area / 1e6,
                    areaWet: a2 / 1e6,
                    areaDeep: a5 / 1e6,
                    maxDepth: maxD,
                    meanDepth: cnt ? sumD / cnt : 0,
                    volume: vol * 1e-4,
                    points: cnt,
                });
            }
        }

        var simMs = now() - t0;
        return {
            frames: frames, hmax: hmax, rain: rain, dt: dt, steps: steps,
            simMs: simMs, outfall: outfall, hmaxAll: hmaxAll,
            totalT: totalT,
        };
    }

    // ---------------- 连通域 / 问题点 ----------------
    function extractZones(dom, depthField, minAreaKm2) {
        var n = dom.n, N = dom.N, mask = dom.mask;
        var lab = new Int32Array(N).fill(-1);
        var zones = [];
        var stack = new Int32Array(N);
        var minCells = Math.max(2, Math.round((minAreaKm2 || 0.35) * 1e6 / dom.cellArea));
        for (var k = 0; k < N; k++) {
            if (lab[k] >= 0 || !mask[k] || depthField[k] < POND) continue;
            var sp = 0; stack[sp++] = k; lab[k] = zones.length;
            var cellsIdx = [];
            var maxD = 0, sumD = 0, minElev = 1e9;
            while (sp > 0) {
                var c = stack[--sp];
                cellsIdx.push(c);
                var d = depthField[c];
                sumD += d; if (d > maxD) maxD = d;
                if (dom.z[c] < minElev) minElev = dom.z[c];
                var ci = c % n, cj = (c / n) | 0;
                for (var d4 = 0; d4 < 4; d4++) {
                    var ni = ci + (d4 === 0 ? 1 : d4 === 1 ? -1 : 0);
                    var nj = cj + (d4 === 2 ? 1 : d4 === 3 ? -1 : 0);
                    if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
                    var t = nj * n + ni;
                    if (lab[t] >= 0 || !mask[t] || depthField[t] < POND) continue;
                    lab[t] = zones.length; stack[sp++] = t;
                }
            }
            if (cellsIdx.length >= minCells) {
                var sx = 0, sy = 0;
                for (var c2 = 0; c2 < cellsIdx.length; c2++) { sx += cellsIdx[c2] % n; sy += (cellsIdx[c2] / n) | 0; }
                var mx = sx / cellsIdx.length, my = sy / cellsIdx.length;
                var lon = dom.bbox[0] + (mx + 0.5) / n * (dom.bbox[2] - dom.bbox[0]);
                var lat = dom.bbox[3] - (my + 0.5) / n * (dom.bbox[3] - dom.bbox[1]);
                zones.push({
                    id: "FP-" + String(zones.length + 1).padStart(2, "0"),
                    idx: cellsIdx, lon: lon, lat: lat,
                    cells: cellsIdx.length,
                    areaKm2: cellsIdx.length * dom.cellArea / 1e6,
                    maxDepth: maxD,
                    meanDepth: sumD / cellsIdx.length,
                    minElev: minElev,
                });
            } else {
                for (var c3 = 0; c3 < cellsIdx.length; c3++) lab[cellsIdx[c3]] = -2;
            }
        }
        zones.sort(function (a, b) { return b.areaKm2 * b.maxDepth - a.areaKm2 * a.maxDepth; });
        // 兜底：个别城市（如西安，干旱区雨量小、积水碎而散）凑不出 0.35 km² 的连片，
        // 会返回空列表、界面看上去"没算出来"。此时放宽到 0.05 km² 再取一次，
        // 至少把最大的几处积水点标出来。
        if (!zones.length && minCells > 3) return extractZones(dom, depthField, 0.05);
        return zones;
    }

    // ---------------- 风险评估 ----------------
    function riskLevelOf(v) {
        for (var i = 0; i < RISK_LEVELS.length; i++) if (v >= RISK_LEVELS[i].min) return RISK_LEVELS[i];
        return RISK_LEVELS[RISK_LEVELS.length - 1];
    }

    function assess(dom, depthField, hmaxField, rainTotal) {
        var n = dom.n, N = dom.N, mask = dom.mask;
        var H = new Float32Array(N), E = new Float32Array(N), V = new Float32Array(N), R = new Float32Array(N);
        var level = new Uint8Array(N);
        var popCity = dom.city.pop_wan * 10000 / dom.city.area_km2;   // 人/km²
        var zSorted = [];
        for (var i0 = 0; i0 < N; i0++) if (mask[i0]) zSorted.push(dom.z[i0]);
        zSorted.sort(function (a, b) { return a - b; });
        var zLo = zSorted[Math.floor(zSorted.length * 0.3)], zHi = zSorted[Math.floor(zSorted.length * 0.98)];
        var relief = Math.max(4, zHi - zLo);

        for (var k = 0; k < N; k++) {
            if (!mask[k]) { level[k] = 4; continue; }
            var elevNorm = clamp((dom.z[k] - zLo) / relief, 0, 1);
            var hz = clamp(
                0.46 * clamp(hmaxField[k] / 0.6, 0, 1) +
                0.26 * clamp(dom.accNorm[k] / 0.7, 0, 1) +
                0.16 * (1 - elevNorm) +
                0.12 * clamp(rainTotal / 250, 0, 1), 0, 1);
            var ex = clamp(
                0.52 * clamp(dom.urban[k] / 0.85, 0, 1) +
                0.28 * clamp(popCity / 8000, 0, 1) * (0.4 + 0.6 * dom.urban[k]) +
                0.20 * clamp(depthField[k] / POND, 0, 1), 0, 1);
            var dd = clamp(1 - dom.drainMh[k] / Math.max(15, dom.city.drain.capacity_mm_h * 1.2), 0, 1);
            var vu = clamp(0.4 * dom.imperv[k] + 0.34 * dd + 0.26 * (1 - clamp(dom.city.drain.coverage, 0, 1)), 0, 1);
            H[k] = hz * 100; E[k] = ex * 100; V[k] = vu * 100;
            var r = 100 * (0.44 * hz + 0.30 * ex + 0.26 * vu);
            R[k] = r;
            level[k] = RISK_LEVELS.findIndex(function (l) { return r >= l.min; });
        }

        // 统计
        var sumR = 0, sumH = 0, sumE = 0, sumV = 0, cnt = 0;
        var areaByLevel = [0, 0, 0, 0, 0], cntByLevel = [0, 0, 0, 0, 0];
        for (var s = 0; s < N; s++) {
            if (!mask[s]) continue;
            cnt++;
            sumR += R[s]; sumH += H[s]; sumE += E[s]; sumV += V[s];
            var li = level[s] < 0 ? 4 : level[s];
            areaByLevel[li] += dom.cellArea / 1e6;
            cntByLevel[li]++;
        }
        return {
            H: H, E: E, V: V, R: R, level: level,
            stats: {
                H: sumH / cnt, E: sumE / cnt, V: sumV / cnt,
                R: sumR / cnt,
                areaByLevel: areaByLevel, cntByLevel: cntByLevel,
                maxLevel: RISK_LEVELS[Math.max(0, RISK_LEVELS.findIndex(function (l, i) {
                    return cntByLevel[i] > cnt * 0.02;
                }))],
            },
        };
    }

    // ---------------- 时序代理（时空降维） ----------------
    // 对每个格点用三参数（峰值水深 / 峰现时间 / 退水常数）重建过程线
    function fitHydrograph(frames, N, dtH) {
        var F = frames.length;
        var hmaxF = new Float32Array(N);
        var tpeakF = new Float32Array(N);
        for (var k = 0; k < N; k++) {
            var mx = 0, tp = 0;
            for (var f = 0; f < F; f++) {
                var d = frames[f].depths[k] / 1000;
                if (d > mx) { mx = d; tp = frames[f].t; }
            }
            hmaxF[k] = mx; tpeakF[k] = tp || 1;
        }
        // 退水常数：峰值后到 1/3 峰值所需时间
        var tauF = new Float32Array(N);
        for (var k2 = 0; k2 < N; k2++) {
            var mx2 = hmaxF[k2];
            if (mx2 < 0.02) { tauF[k2] = 1; continue; }
            var tp2 = tpeakF[k2], found = -1, f0 = 0;
            for (var f2 = 0; f2 < F; f2++) if (Math.abs(frames[f2].t - tp2) < 1e-6) { f0 = f2; break; }
            for (var f3 = f0; f3 < F; f3++) {
                if (frames[f3].depths[k2] / 1000 < mx2 / 3) { found = frames[f3].t - tp2; break; }
            }
            tauF[k2] = found > 0 ? found / Math.log(3) : Math.max(0.35, F * dtH * 0.25);
        }
        return { hmax: hmaxF, tpeak: tpeakF, tau: tauF };
    }

    function rebuildFrame(par, k, t) {
        var hm = par.hmax[k];
        if (hm < 0.004) return 0;
        var tp = par.tpeak[k], tau = par.tau[k];
        if (t <= tp) {
            var x = tp > 0 ? t / tp : 1;
            return hm * Math.pow(clamp(x, 0, 1), 2.0);
        }
        return hm * Math.exp(-(t - tp) / Math.max(0.12, tau));
    }

    return {
        POND: POND, N_MAN: N_MAN, PARAMS: PARAMS, setParams: setParams,
        RISK_LEVELS: RISK_LEVELS, CAUSES: CAUSES,
        idf: idf, makeRain: makeRain, buildDomain: buildDomain, runSim: runSim,
        extractZones: extractZones, assess: assess, riskLevelOf: riskLevelOf,
        fitHydrograph: fitHydrograph, rebuildFrame: rebuildFrame,
        _internals: { fillMask: fillMask, sampleDEM: sampleDEM, b64ToInt16: b64ToInt16, demElev: demElev, patternWeights: patternWeights },
    };
});
