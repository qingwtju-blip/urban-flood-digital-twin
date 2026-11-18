/* ============================================================
   城市内涝积水预测 · 轻量机器学习内核 (FloodML)
   ------------------------------------------------------------
   纯前端可运行（无 Python 依赖），实现 5 类主流集成学习算法：
     rf    随机森林（Bagging + 随机特征子空间 + CART 回归树）
     gbdt  梯度提升树（一阶梯度 + 深度优先）
     xgb   XGBoost 同源机制（二阶梯度 + 正则项 + colsample/subsample + gamma）
     lgbm  LightGBM 同源机制（直方图分裂 + 叶子优先生长 num_leaves）
     cat   CatBoost 同源机制（对称/遗忘树 oblivious tree + L2 正则）
   说明：为便于在浏览器/离线环境直接运行，以上为按各算法原始论文与
   开源实现的核心机制重写的轻量版本，并非官方库。样本量较大或需严格
   复现时，可导出训练样本(CSV)交由本地 Python 版官方库训练。
   ============================================================ */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.FloodML = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var FEATURES = [
        { key: "elevNorm", name: "相对高程" },
        { key: "slope", name: "地面坡度" },
        { key: "accNorm", name: "汇流累积量" },
        { key: "impervious", name: "不透水率" },
        { key: "cn", name: "SCS-CN 值" },
        { key: "drainCap", name: "管网排水能力" },
        { key: "riverProx", name: "河道邻近度" },
        { key: "urbanScore", name: "城市化强度" },
        { key: "rainCell", name: "网格降雨量" },
        { key: "logP", name: "log(重现期)" },
        { key: "duration", name: "降雨历时" },
    ];

    var ALGOS = {
        rf: {
            name: "随机森林 RF",
            short: "RF",
            desc: "Bagging 自助采样 + 节点随机特征子空间 + 回归树取均值，抗过拟合、可给出袋外重要性",
            color: "#36df86",
            params: [
                { key: "n_estimators", label: "树数量 n_estimators", min: 20, max: 400, step: 10, value: 120, type: "int" },
                { key: "max_depth", label: "最大深度 max_depth", min: 3, max: 16, step: 1, value: 14, type: "int" },
                { key: "min_samples_leaf", label: "叶最小样本 min_samples_leaf", min: 1, max: 30, step: 1, value: 1, type: "int" },
                { key: "max_features", label: "特征子集 max_features", min: 2, max: 10, step: 1, value: 7, type: "int" },
            ],
        },
        gbdt: {
            name: "梯度提升树 GBDT",
            short: "GBDT",
            desc: "一阶梯度提升，逐棵树拟合残差，深度优先生长",
            color: "#00d3ff",
            params: [
                { key: "n_estimators", label: "迭代轮数 n_estimators", min: 20, max: 400, step: 10, value: 200, type: "int" },
                { key: "learning_rate", label: "学习率 learning_rate", min: 0.02, max: 0.5, step: 0.01, value: 0.15, type: "float" },
                { key: "max_depth", label: "最大深度 max_depth", min: 2, max: 10, step: 1, value: 6, type: "int" },
                { key: "subsample", label: "行采样 subsample", min: 0.5, max: 1, step: 0.05, value: 0.9, type: "float" },
                { key: "min_samples_leaf", label: "叶最小样本 min_samples_leaf", min: 1, max: 30, step: 1, value: 2, type: "int" },
            ],
        },
        xgb: {
            name: "XGBoost",
            short: "XGB",
            desc: "二阶泰勒展开 + 结构风险正则 + 列/行采样 + gamma 剪枝",
            color: "#ff9820",
            params: [
                { key: "n_estimators", label: "迭代轮数 n_estimators", min: 20, max: 400, step: 10, value: 200, type: "int" },
                { key: "learning_rate", label: "学习率 eta", min: 0.02, max: 0.5, step: 0.01, value: 0.10, type: "float" },
                { key: "max_depth", label: "最大深度 max_depth", min: 2, max: 12, step: 1, value: 6, type: "int" },
                { key: "min_child_weight", label: "叶节点最小权重 min_child_weight", min: 1, max: 30, step: 1, value: 1, type: "int" },
                { key: "reg_lambda", label: "L2 正则 lambda", min: 0, max: 10, step: 0.1, value: 1.0, type: "float" },
                { key: "gamma", label: "分裂阈值 gamma", min: 0, max: 0.2, step: 0.01, value: 0, type: "float" },
                { key: "subsample", label: "行采样 subsample", min: 0.5, max: 1, step: 0.05, value: 0.85, type: "float" },
                { key: "colsample", label: "列采样 colsample_bytree", min: 0.4, max: 1, step: 0.05, value: 0.85, type: "float" },
            ],
        },
        lgbm: {
            name: "LightGBM",
            short: "LGBM",
            desc: "直方图分桶 + 叶子优先(leaf-wise)生长 + num_leaves 控制复杂度",
            color: "#ab47bc",
            params: [
                { key: "n_estimators", label: "迭代轮数 n_estimators", min: 20, max: 400, step: 10, value: 120, type: "int" },
                { key: "learning_rate", label: "学习率 learning_rate", min: 0.02, max: 0.5, step: 0.01, value: 0.10, type: "float" },
                { key: "num_leaves", label: "叶子数 num_leaves", min: 8, max: 127, step: 1, value: 31, type: "int" },
                { key: "max_depth", label: "最大深度 max_depth", min: 3, max: 12, step: 1, value: 10, type: "int" },
                { key: "min_data_in_leaf", label: "叶最小样本 min_data_in_leaf", min: 1, max: 40, step: 1, value: 8, type: "int" },
                { key: "feature_fraction", label: "列采样 feature_fraction", min: 0.4, max: 1, step: 0.05, value: 0.9, type: "float" },
                { key: "bagging_fraction", label: "行采样 bagging_fraction", min: 0.5, max: 1, step: 0.05, value: 0.9, type: "float" },
            ],
        },
        cat: {
            name: "CatBoost（对称树）",
            short: "CAT",
            desc: "oblivious 对称树：每层全树共用同一分裂，天然抗过拟合",
            color: "#ffd247",
            params: [
                { key: "n_estimators", label: "迭代轮数 n_estimators", min: 20, max: 400, step: 10, value: 150, type: "int" },
                { key: "learning_rate", label: "学习率 learning_rate", min: 0.02, max: 0.5, step: 0.01, value: 0.12, type: "float" },
                { key: "depth", label: "对称树深度 depth", min: 3, max: 10, step: 1, value: 8, type: "int" },
                { key: "l2_leaf_reg", label: "L2 正则 l2_leaf_reg", min: 0, max: 10, step: 0.5, value: 1.5, type: "float" },
                { key: "rsm", label: "列采样 rsm", min: 0.4, max: 1, step: 0.05, value: 0.9, type: "float" },
            ],
        },
    };

    var MAX_BINS = 16;

    function mulberry32(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6d2b79f5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function defaultParams(algo) {
        var out = {};
        (ALGOS[algo] || ALGOS.rf).params.forEach(function (p) { out[p.key] = p.value; });
        return out;
    }

    // ---------- 分桶 ----------
    function buildBins(X) {
        var f = X[0].length, m = X.length, edges = [];
        for (var j = 0; j < f; j++) {
            var col = new Array(m);
            for (var i = 0; i < m; i++) col[i] = X[i][j];
            col.sort(function (a, b) { return a - b; });
            var e = [];
            for (var b = 1; b < MAX_BINS; b++) {
                e.push(col[Math.min(m - 1, Math.floor(m * b / MAX_BINS))]);
            }
            edges.push(e);
        }
        return edges;
    }

    function binOf(v, edges) {
        var lo = 0, hi = edges.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (v <= edges[mid]) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    function toBins(X, edges) {
        var m = X.length, f = edges.length;
        var Xb = new Array(m);
        for (var i = 0; i < m; i++) {
            var row = new Uint8Array(f);
            for (var j = 0; j < f; j++) row[j] = binOf(X[i][j], edges[j]);
            Xb[i] = row;
        }
        return Xb;
    }

    // ---------- 分裂搜索（直方图） ----------
    var pool = {};

    function bestSplit(idx, Xb, g, h, params, rnd, featSubset, lambda, minLeaf, mode) {
        var B = MAX_BINS;
        var nF = Xb[0].length;
        var best = null;
        var G = 0, H = 0;
        for (var t = 0; t < idx.length; t++) { G += g[idx[t]]; H += h[idx[t]]; }
        var parentScore = G * G / (H + lambda);

        if (!pool.g) pool.g = new Float64Array(nF * B);
        var cumG = pool.g, cumH = new Float64Array(nF * B), cumN = new Float64Array(nF * B);
        cumG.fill(0); cumH.fill(0); cumN.fill(0);

        for (var i = 0; i < idx.length; i++) {
            var r = idx[i], xb = Xb[r];
            for (var j = 0; j < nF; j++) {
                var pos = j * B + xb[j];
                cumG[pos] += g[r];
                cumH[pos] += h[r];
                cumN[pos] += 1;
            }
        }

        for (var jj = 0; jj < nF; jj++) {
            if (featSubset && featSubset.indexOf(jj) < 0) continue;
            var gL = 0, hL = 0, nL = 0;
            for (var k = 0; k < B - 1; k++) {
                gL += cumG[jj * B + k];
                hL += cumH[jj * B + k];
                nL += cumN[jj * B + k];
                var nR = idx.length - nL;
                if (nL < minLeaf || nR < minLeaf) continue;
                var gR = G - gL, hR = H - hL;
                var gain = 0.5 * (gL * gL / (hL + lambda) + gR * gR / (hR + lambda) - parentScore);
                if (mode === "xgb" && (hL < params.min_child_weight || hR < params.min_child_weight)) continue;
                if (!best || gain > best.gain) {
                    best = { feat: jj, bin: k, gain: gain, gL: gL, hL: hL, gR: gR, hR: hR, nL: nL, nR: nR };
                }
            }
        }
        return best;
    }

    function makeLeaf(value, n) {
        return { leaf: value, n: n };
    }

    // ---------- 深度优先提升树（GBDT / XGBoost / RF） ----------
    function growDepthwise(Xb, g, h, idx, depth, params, lambda, gamma, minLeaf, featSubset, rnd, mode, importance) {
        var n = idx.length;
        var leafMode = mode === "rf" ? "mean" : "grad";
        if (depth <= 0 || n < 2 * minLeaf) {
            var G = 0, H = 0;
            for (var i = 0; i < n; i++) { G += g[idx[i]]; H += h[idx[i]]; }
            return makeLeaf(leafMode === "mean" ? G / Math.max(1, n) : -G / (H + lambda), n);
        }
        var sp = bestSplit(idx, Xb, g, h, params, rnd, featSubset, lambda, minLeaf, mode);
        if (!sp || sp.gain <= gamma) {
            var G2 = 0, H2 = 0;
            for (var i2 = 0; i2 < n; i2++) { G2 += g[idx[i2]]; H2 += h[idx[i2]]; }
            return makeLeaf(leafMode === "mean" ? G2 / Math.max(1, n) : -G2 / (H2 + lambda), n);
        }
        if (importance) importance[sp.feat] += sp.gain;
        var L = [], R = [];
        for (var t = 0; t < n; t++) {
            var r = idx[t];
            if (Xb[r][sp.feat] <= sp.bin) L.push(r); else R.push(r);
        }
        return {
            feat: sp.feat,
            bin: sp.bin,
            n: n,
            gain: sp.gain,
            left: growDepthwise(Xb, g, h, L, depth - 1, params, lambda, gamma, minLeaf, featSubset, rnd, mode, importance),
            right: growDepthwise(Xb, g, h, R, depth - 1, params, lambda, gamma, minLeaf, featSubset, rnd, mode, importance),
        };
    }

    // ---------- 叶子优先（LightGBM） ----------
    function growLeafwise(Xb, g, h, rootIdx, params, lambda, minLeaf, feats, rnd, importance) {
        var root = { idx: rootIdx, depth: 0 };
        var leaves = [root];
        var maxLeaves = params.num_leaves || 31;
        var maxDepth = params.max_depth || 8;

        function leafValue(node) {
            var G = 0, H = 0;
            for (var i = 0; i < node.idx.length; i++) { var r = node.idx[i]; G += g[r]; H += h[r]; }
            return { leaf: -G / (H + lambda), n: node.idx.length };
        }

        while (leaves.length < maxLeaves) {
            var bestNode = null, bestSp = null, bestScore = -Infinity;
            for (var li = 0; li < leaves.length; li++) {
                var nd = leaves[li];
                if (!nd.idx || nd.idx.length < 2 * minLeaf || nd.depth >= maxDepth) continue;
                var sub = feats && feats.length < 11 ? feats : null;
                var sp = bestSplit(nd.idx, Xb, g, h, params, rnd, sub, lambda, minLeaf, "lgbm");
                if (sp && sp.gain > bestScore) { bestScore = sp.gain; bestNode = nd; bestSp = sp; }
            }
            if (!bestNode || !bestSp || bestSp.gain <= 0) break;
            if (importance) importance[bestSp.feat] += bestSp.gain;
            var L = [], R = [];
            for (var t = 0; t < bestNode.idx.length; t++) {
                var r = bestNode.idx[t];
                if (Xb[r][bestSp.feat] <= bestSp.bin) L.push(r); else R.push(r);
            }
            var parentIdx = bestNode.idx;
            delete bestNode.idx;
            bestNode.feat = bestSp.feat;
            bestNode.bin = bestSp.bin;
            bestNode.left = { idx: L, depth: bestNode.depth + 1 };
            bestNode.right = { idx: R, depth: bestNode.depth + 1 };
            leaves.splice(leaves.indexOf(bestNode), 1);
            leaves.push(bestNode.left, bestNode.right);
            void parentIdx;
        }
        (function finalize(node) {
            if (node.left) { finalize(node.left); finalize(node.right); return; }
            var lv = leafValue(node);
            node.leaf = lv.leaf;
            node.n = lv.n;
            delete node.idx;
        })(root);
        return root;
    }

    // ---------- 对称树（CatBoost oblivious，逐层全树统一分裂 + 叶内增益求和） ----------
    function growOblivious(Xb, g, h, idx, params, lambda, minLeaf, rnd, importance) {
        var depth = params.depth || 6;
        var B = MAX_BINS;
        var nF = Xb[0].length;
        var leaves = [idx];
        var splits = [];

        for (var d = 0; d < depth; d++) {
            var nLeaf = leaves.length;
            var histG = [], histH = [], histN = [], totG = [], totH = [], totN = [];
            for (var li = 0; li < nLeaf; li++) {
                var hg = new Float64Array(nF * B), hh = new Float64Array(nF * B), hn = new Float64Array(nF * B);
                var arr = leaves[li];
                var G = 0, H = 0;
                for (var t = 0; t < arr.length; t++) {
                    var r = arr[t], xb = Xb[r], gr = g[r], hr = h[r];
                    G += gr; H += hr;
                    for (var f = 0; f < nF; f++) {
                        var pos = f * B + xb[f];
                        hg[pos] += gr; hh[pos] += hr; hn[pos] += 1;
                    }
                }
                histG.push(hg); histH.push(hh); histN.push(hn);
                totG.push(G); totH.push(H); totN.push(arr.length);
            }

            var best = null;
            for (var fj = 0; fj < nF; fj++) {
                if (params.rsm && params.rsm < 1 && rnd() > params.rsm) continue;
                for (var b = 0; b < B - 1; b++) {
                    var gainTotal = 0, ok = true;
                    for (var lj = 0; lj < nLeaf; lj++) {
                        var gL = 0, hL = 0, nL = 0;
                        for (var k = 0; k <= b; k++) {
                            gL += histG[lj][fj * B + k];
                            hL += histH[lj][fj * B + k];
                            nL += histN[lj][fj * B + k];
                        }
                        var gR = totG[lj] - gL, hR = totH[lj] - hL, nR = totN[lj] - nL;
                        if (nL < minLeaf || nR < minLeaf) { ok = false; break; }
                        var parent = totG[lj] * totG[lj] / (totH[lj] + lambda);
                        gainTotal += 0.5 * (gL * gL / (hL + lambda) + gR * gR / (hR + lambda) - parent);
                    }
                    if (!ok || gainTotal <= 0) continue;
                    if (!best || gainTotal > best.gain) best = { feat: fj, bin: b, gain: gainTotal };
                }
            }
            if (!best) break;
            if (importance) importance[best.feat] += best.gain;
            splits.push({ feat: best.feat, bin: best.bin });

            var next = [];
            for (var lk = 0; lk < nLeaf; lk++) {
                var L = [], R = [];
                for (var t2 = 0; t2 < leaves[lk].length; t2++) {
                    var r2 = leaves[lk][t2];
                    if (Xb[r2][best.feat] <= best.bin) L.push(r2); else R.push(r2);
                }
                next.push(L, R);
            }
            leaves = next;
        }

        var values = leaves.map(function (arr2) {
            var G2 = 0, H2 = 0;
            for (var i = 0; i < arr2.length; i++) { var rr = arr2[i]; G2 += g[rr]; H2 += h[rr]; }
            return -G2 / (H2 + lambda);
        });
        return { splits: splits, values: values, leaves: leaves };
    }

    function predictOblivious(tree, x, edges) {
        var idx = 0;
        for (var d = 0; d < tree.splits.length; d++) {
            var sp = tree.splits[d];
            var bin = binOf(x[sp.feat], edges[sp.feat]);
            idx = idx * 2 + (bin <= sp.bin ? 0 : 1);
        }
        return tree.values[idx] || 0;
    }

    function predictTree(node, x, edges) {
        var cur = node;
        while (cur && cur.feat !== undefined && cur.left) {
            var bin = binOf(x[cur.feat], edges[cur.feat]);
            cur = bin <= cur.bin ? cur.left : cur.right;
        }
        return cur && cur.leaf !== undefined ? cur.leaf : 0;
    }

    // ---------- 训练入口 ----------
    function train(X, y, algo, params, seed) {
        var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        var rnd = mulberry32(seed || 42);
        var m = X.length, f = X[0].length;
        var p = Object.assign(defaultParams(algo), params || {});
        var edges = buildBins(X);
        var Xb = toBins(X, edges);
        var importance = new Float64Array(f);
        var model = { algo: algo, params: p, edges: edges, trees: [], base: 0 };

        var mean = 0;
        for (var i = 0; i < m; i++) mean += y[i];
        mean /= m;

        if (algo === "rf") {
            var nTree = p.n_estimators || 120;
            for (var t = 0; t < nTree; t++) {
                var bag = [];
                for (var b = 0; b < m; b++) bag.push(Math.floor(rnd() * m));
                var feats = sampleFeatures(f, Math.min(f, p.max_features || 5), rnd);
                var gArr = new Float64Array(m), hArr = new Float64Array(m);
                // 用方差增益等价形式：g = y - mean, h = 1，lambda = 0 → 方差减少
                for (var q = 0; q < m; q++) { gArr[q] = y[q]; hArr[q] = 1; }
                var tree = growDepthwise(Xb, gArr, hArr, bag, p.max_depth || 8, p, 0, 0, p.min_samples_leaf || 4, feats, rnd, "rf", importance);
                tree.leafMean = true;
                model.trees.push(tree);
            }
            model.base = mean;
        } else if (algo === "gbdt" || algo === "xgb") {
            var pred = new Float64Array(m);
            for (var i2 = 0; i2 < m; i2++) pred[i2] = mean;
            model.base = mean;
            var lambda = algo === "xgb" ? (p.reg_lambda || 1) : 1.0;
            var gamma = algo === "xgb" ? (p.gamma || 0) : 0;
            var minLeaf = algo === "xgb" ? 2 : (p.min_samples_leaf || 5);
            for (var it = 0; it < (p.n_estimators || 150); it++) {
                var rowIdx = [];
                var sub = p.subsample || 0.9;
                for (var r0 = 0; r0 < m; r0++) if (rnd() < sub) rowIdx.push(r0);
                if (rowIdx.length < 10) for (var r1 = 0; r1 < m; r1++) rowIdx.push(r1);
                var g = new Float64Array(m), h = new Float64Array(m);
                for (var k = 0; k < m; k++) { g[k] = pred[k] - y[k]; h[k] = 1; }
                var featSubset = null;
                if (algo === "xgb") {
                    var nSel = Math.max(2, Math.round(f * (p.colsample || 0.8)));
                    featSubset = sampleFeatures(f, nSel, rnd);
                }
                var tr = growDepthwise(Xb, g, h, rowIdx, p.max_depth || 4, p, lambda, gamma, minLeaf, featSubset, rnd, algo, importance);
                var lr = p.learning_rate || 0.1;
                updatePred(tr, Xb, pred, lr);
                model.trees.push(tr);
            }
        } else if (algo === "lgbm") {
            var pred3 = new Float64Array(m);
            for (var i3 = 0; i3 < m; i3++) pred3[i3] = mean;
            model.base = mean;
            for (var it3 = 0; it3 < (p.n_estimators || 150); it3++) {
                var rowIdx3 = [];
                var bf = p.bagging_fraction || 0.9;
                for (var r3 = 0; r3 < m; r3++) if (rnd() < bf) rowIdx3.push(r3);
                if (rowIdx3.length < 20) for (var r4 = 0; r4 < m; r4++) rowIdx3.push(r4);
                var g3 = new Float64Array(m), h3 = new Float64Array(m);
                for (var k3 = 0; k3 < m; k3++) { g3[k3] = pred3[k3] - y[k3]; h3[k3] = 1; }
                var ff = Math.max(2, Math.round(f * (p.feature_fraction || 0.9)));
                var feats3 = sampleFeatures(f, ff, rnd);
                var tr3 = growLeafwise(Xb, g3, h3, rowIdx3, p, 1.0, p.min_data_in_leaf || 8, feats3, rnd, importance);
                updatePred(tr3, Xb, pred3, p.learning_rate || 0.1);
                model.trees.push(tr3);
            }
        } else if (algo === "cat") {
            var pred4 = new Float64Array(m);
            for (var i4 = 0; i4 < m; i4++) pred4[i4] = mean;
            model.base = mean;
            for (var it4 = 0; it4 < (p.n_estimators || 150); it4++) {
                var g4 = new Float64Array(m), h4 = new Float64Array(m);
                for (var k4 = 0; k4 < m; k4++) { g4[k4] = pred4[k4] - y[k4]; h4[k4] = 1; }
                var all = [];
                for (var r5 = 0; r5 < m; r5++) all.push(r5);
                var tr4 = growOblivious(Xb, g4, h4, all, p, p.l2_leaf_reg || 3, 2, rnd, importance);
                for (var r6 = 0; r6 < m; r6++) pred4[r6] += (p.learning_rate || 0.1) * predictOblivious(tr4, X[r6], edges);
                model.trees.push(tr4);
            }
        }

        var impSum = 0;
        for (var fi = 0; fi < f; fi++) impSum += importance[fi];
        model.importance = [];
        for (var fj = 0; fj < f; fj++) {
            model.importance.push(impSum > 0 ? importance[fj] / impSum : 1 / f);
        }
        model.trainMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;

        model.predictOne = function (x) {
            if (algo === "rf") {
                var s = 0;
                for (var i = 0; i < model.trees.length; i++) s += predictTree(model.trees[i], x, edges);
                return s / model.trees.length;
            }
            if (algo === "cat") {
                var s2 = model.base;
                for (var j = 0; j < model.trees.length; j++) s2 += (p.learning_rate || 0.1) * predictOblivious(model.trees[j], x, edges);
                return s2;
            }
            var s3 = model.base;
            for (var k = 0; k < model.trees.length; k++) s3 += (p.learning_rate || 0.1) * predictTree(model.trees[k], x, edges);
            return s3;
        };
        return model;
    }

    function sampleFeatures(f, k, rnd) {
        var arr = [];
        for (var i = 0; i < f; i++) arr.push(i);
        for (var j = arr.length - 1; j > 0; j--) {
            var t = Math.floor(rnd() * (j + 1));
            var tmp = arr[j]; arr[j] = arr[t]; arr[t] = tmp;
        }
        return arr.slice(0, k);
    }

    // RF 叶子取均值需要真实 y；此处按梯度更新近似（对 RF 分支单独预测见 predictTree + leaf 值）
    function updatePred(tree, Xb, pred, lr) {
        for (var i = 0; i < pred.length; i++) {
            pred[i] += lr * predictTreeBin(tree, Xb[i]);
        }
    }

    function predictTreeBin(node, xb) {
        var cur = node;
        while (cur && cur.left) {
            cur = xb[cur.feat] <= cur.bin ? cur.left : cur.right;
        }
        return cur && cur.leaf !== undefined ? cur.leaf : 0;
    }

    function predictBatch(model, X) {
        var out = new Array(X.length);
        var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
        for (var i = 0; i < X.length; i++) out[i] = Math.max(0, model.predictOne(X[i]));
        model.predictMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        return out;
    }

    function metrics(yTrue, yPred, threshold) {
        var n = yTrue.length, mse = 0, mae = 0, mean = 0;
        for (var i = 0; i < n; i++) mean += yTrue[i];
        mean /= n;
        var sst = 0, sse = 0;
        var tp = 0, fp = 0, fn = 0, tn = 0;
        for (var j = 0; j < n; j++) {
            var e = yPred[j] - yTrue[j];
            mse += e * e;
            mae += Math.abs(e);
            sse += e * e;
            sst += (yTrue[j] - mean) * (yTrue[j] - mean);
            var pt = yTrue[j] >= threshold, pp = yPred[j] >= threshold;
            if (pt && pp) tp++; else if (!pt && pp) fp++; else if (pt && !pp) fn++; else tn++;
        }
        var prec = tp + fp > 0 ? tp / (tp + fp) : 0;
        var rec = tp + fn > 0 ? tp / (tp + fn) : 0;
        return {
            r2: sst > 0 ? 1 - sse / sst : 0,
            rmse: Math.sqrt(mse / n),
            mae: mae / n,
            precision: prec,
            recall: rec,
            f1: prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0,
            tp: tp, fp: fp, fn: fn, tn: tn,
            n: n,
        };
    }

    return {
        FEATURES: FEATURES,
        ALGOS: ALGOS,
        defaultParams: defaultParams,
        train: train,
        predictBatch: predictBatch,
        metrics: metrics,
        mulberry32: mulberry32,
    };
});
