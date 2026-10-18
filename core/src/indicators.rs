//! 技术指标库。
//!
//! 设计约定（非常重要）：
//! - 所有序列型指标返回与输入等长的 `Vec<Option<f64>>`，**不截断**。
//!   索引 `i` 对应输入第 `i` 根 Bar，`None` 表示该位置处于预热期、值不可用。
//!   这样在多指标对齐、画图、策略判断时都不需要再做下标补偿。
//! - 只接受 `f64` 切片，不感知 Bar 结构，便于单元测试。
//! - 不使用 `unsafe`，不做 panic 式取值；周期为 0 或数据不足时返回全 `None`。

/// 简单移动平均。
pub fn sma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    let mut sum: f64 = values[..period].iter().sum();
    out[period - 1] = Some(sum / period as f64);
    for i in period..n {
        sum += values[i] - values[i - period];
        out[i] = Some(sum / period as f64);
    }
    out
}

/// 指数移动平均。首个有效值用前 `period` 个样本的简单平均作为种子，
/// 与通达信 / 同花顺 / AkShare 的常见口径一致（而非从第一个值直接起步）。
pub fn ema(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    let alpha = 2.0 / (period as f64 + 1.0);
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = Some(seed);
    let mut prev = seed;
    for i in period..n {
        prev = values[i] * alpha + prev * (1.0 - alpha);
        out[i] = Some(prev);
    }
    out
}

/// 加权移动平均（线性权重，最近一期权重最大）。
pub fn wma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    let weight_sum = (period * (period + 1)) as f64 / 2.0;
    for i in (period - 1)..n {
        let mut acc = 0.0;
        for k in 0..period {
            acc += values[i + 1 - period + k] * (k as f64 + 1.0);
        }
        out[i] = Some(acc / weight_sum);
    }
    out
}

/// Wilder 平滑（RMA）：alpha = 1 / period，用于 RSI / ATR / ADX。
pub fn rma(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    let seed: f64 = values[..period].iter().sum::<f64>() / period as f64;
    out[period - 1] = Some(seed);
    let mut prev = seed;
    for i in period..n {
        prev = (prev * (period as f64 - 1.0) + values[i]) / period as f64;
        out[i] = Some(prev);
    }
    out
}

/// 滚动标准差（样本标准差，分母 n-1）。
pub fn rolling_std(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period < 2 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        let window = &values[i + 1 - period..=i];
        let mean = window.iter().sum::<f64>() / period as f64;
        let var = window.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (period as f64 - 1.0);
        out[i] = Some(var.sqrt());
    }
    out
}

/// MACD：返回 (DIF, DEA, MACD 柱)。
/// A 股常用参数 (12, 26, 9)；柱状值按国内习惯取 `2 * (DIF - DEA)`。
pub fn macd(
    close: &[f64],
    fast: usize,
    slow: usize,
    signal: usize,
) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = close.len();
    let ema_fast = ema(close, fast);
    let ema_slow = ema(close, slow);

    let mut dif = vec![None; n];
    for i in 0..n {
        if let (Some(f), Some(s)) = (ema_fast[i], ema_slow[i]) {
            dif[i] = Some(f - s);
        }
    }

    // DEA 需要 DIF 的有效值序列做 EMA，此处保持下标对齐
    let mut dea = vec![None; n];
    let start = dif.iter().position(|v| v.is_some());
    if let Some(start) = start {
        let compact: Vec<f64> = dif[start..].iter().map(|v| v.unwrap_or(0.0)).collect();
        let compact_dea = ema(&compact, signal);
        for (offset, value) in compact_dea.into_iter().enumerate() {
            if let Some(v) = value {
                dea[start + offset] = Some(v);
            }
        }
    }

    let mut hist = vec![None; n];
    for i in 0..n {
        if let (Some(d), Some(e)) = (dif[i], dea[i]) {
            hist[i] = Some(2.0 * (d - e));
        }
    }
    (dif, dea, hist)
}

/// RSI（Wilder 平滑口径），取值 0~100。
pub fn rsi(close: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if period == 0 || n < period + 1 {
        return out;
    }
    let mut gains = vec![0.0; n];
    let mut losses = vec![0.0; n];
    for i in 1..n {
        let delta = close[i] - close[i - 1];
        if delta >= 0.0 {
            gains[i] = delta;
        } else {
            losses[i] = -delta;
        }
    }
    // 第 0 根无涨跌，用后续 period 根做种子
    let avg_gain = rma(&gains[1..], period);
    let avg_loss = rma(&losses[1..], period);
    for i in 0..avg_gain.len() {
        if let (Some(g), Some(l)) = (avg_gain[i], avg_loss[i]) {
            let value = if l == 0.0 {
                100.0
            } else {
                let rs = g / l;
                100.0 - 100.0 / (1.0 + rs)
            };
            out[i + 1] = Some(value);
        }
    }
    out
}

/// KDJ：返回 (K, D, J)。RSV 的 N 日窗口，K/D 做 (2/3, 1/3) 递推，初值 50。
pub fn kdj(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    n: usize,
    k_period: f64,
    d_period: f64,
) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let len = close.len();
    let mut k_out = vec![None; len];
    let mut d_out = vec![None; len];
    let mut j_out = vec![None; len];
    if n == 0 || len < n || high.len() != len || low.len() != len {
        return (k_out, d_out, j_out);
    }

    let mut prev_k = 50.0;
    let mut prev_d = 50.0;
    for i in (n - 1)..len {
        let hh = high[i + 1 - n..=i].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let ll = low[i + 1 - n..=i].iter().cloned().fold(f64::INFINITY, f64::min);
        let rsv = if (hh - ll).abs() < f64::EPSILON {
            // 一字板等极端情况：区间为 0，RSV 沿用 50，避免除零
            50.0
        } else {
            (close[i] - ll) / (hh - ll) * 100.0
        };
        let k = (k_period - 1.0) / k_period * prev_k + rsv / k_period;
        let d = (d_period - 1.0) / d_period * prev_d + k / d_period;
        let j = 3.0 * k - 2.0 * d;
        k_out[i] = Some(k);
        d_out[i] = Some(d);
        j_out[i] = Some(j);
        prev_k = k;
        prev_d = d;
    }
    (k_out, d_out, j_out)
}

/// 布林带：返回 (中轨, 上轨, 下轨)。
pub fn boll(close: &[f64], period: usize, mult: f64) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let mid = sma(close, period);
    let std = rolling_std(close, period);
    let n = close.len();
    let mut upper = vec![None; n];
    let mut lower = vec![None; n];
    for i in 0..n {
        if let (Some(m), Some(s)) = (mid[i], std[i]) {
            upper[i] = Some(m + mult * s);
            lower[i] = Some(m - mult * s);
        }
    }
    (mid, upper, lower)
}

/// 真实波幅序列（TR）。
pub fn true_range(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    let n = close.len();
    let mut tr = vec![0.0; n];
    if n == 0 {
        return tr;
    }
    tr[0] = high[0] - low[0];
    for i in 1..n {
        let a = high[i] - low[i];
        let b = (high[i] - close[i - 1]).abs();
        let c = (low[i] - close[i - 1]).abs();
        tr[i] = a.max(b).max(c);
    }
    tr
}

/// ATR（Wilder 平滑）。
pub fn atr(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<Option<f64>> {
    let tr = true_range(high, low, close);
    rma(&tr, period)
}

/// CCI：典型价格偏离度 / (0.015 × 平均绝对偏差)。窗口内偏差使用同一均值。
pub fn cci(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    let tp: Vec<f64> = (0..n).map(|i| (high[i] + low[i] + close[i]) / 3.0).collect();
    let ma = sma(&tp, period);
    for i in (period - 1)..n {
        let m = match ma[i] {
            Some(v) => v,
            None => continue,
        };
        let window = &tp[i + 1 - period..=i];
        let mean_dev = window.iter().map(|v| (v - m).abs()).sum::<f64>() / period as f64;
        out[i] = if mean_dev.abs() < f64::EPSILON {
            Some(0.0)
        } else {
            Some((tp[i] - m) / (0.015 * mean_dev))
        };
    }
    out
}

/// OBV（能量潮）：涨日加量、跌日减量，首值为 0。
pub fn obv(close: &[f64], volume: &[f64]) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if n == 0 {
        return out;
    }
    let mut acc = 0.0;
    out[0] = Some(0.0);
    for i in 1..n {
        if close[i] > close[i - 1] {
            acc += volume[i];
        } else if close[i] < close[i - 1] {
            acc -= volume[i];
        }
        out[i] = Some(acc);
    }
    out
}

/// ROC（变动率，百分比）。
pub fn roc(close: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if period == 0 || n <= period {
        return out;
    }
    for i in period..n {
        let base = close[i - period];
        if base.abs() > f64::EPSILON {
            out[i] = Some((close[i] - base) / base * 100.0);
        }
    }
    out
}

/// DMI：返回 (+DI, -DI, ADX)。
pub fn dmi(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    adx_period: usize,
) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = close.len();
    let mut plus_di = vec![None; n];
    let mut minus_di = vec![None; n];
    let mut adx_out = vec![None; n];
    if period == 0 || n < period + 1 {
        return (plus_di, minus_di, adx_out);
    }

    let mut plus_dm = vec![0.0; n];
    let mut minus_dm = vec![0.0; n];
    for i in 1..n {
        let up = high[i] - high[i - 1];
        let down = low[i - 1] - low[i];
        if up > down && up > 0.0 {
            plus_dm[i] = up;
        }
        if down > up && down > 0.0 {
            minus_dm[i] = down;
        }
    }

    let tr = true_range(high, low, close);
    let atr_s = rma(&tr, period);
    let pdm_s = rma(&plus_dm, period);
    let mdm_s = rma(&minus_dm, period);

    let mut dx = vec![0.0; n];
    let mut dx_valid = vec![false; n];
    for i in 0..n {
        if let (Some(a), Some(p), Some(m)) = (atr_s[i], pdm_s[i], mdm_s[i]) {
            if a > f64::EPSILON {
                let pdi = p / a * 100.0;
                let mdi = m / a * 100.0;
                plus_di[i] = Some(pdi);
                minus_di[i] = Some(mdi);
                let denom = pdi + mdi;
                if denom.abs() > f64::EPSILON {
                    dx[i] = (pdi - mdi).abs() / denom * 100.0;
                    dx_valid[i] = true;
                }
            }
        }
    }

    // ADX = DX 的 Wilder 平滑；只在 DX 有效的位置推进
    let valid: Vec<f64> = dx
        .iter()
        .zip(dx_valid.iter())
        .filter(|(_, ok)| **ok)
        .map(|(v, _)| *v)
        .collect();
    if valid.len() >= adx_period {
        let smoothed = rma(&valid, adx_period);
        let mut cursor = 0usize;
        for i in 0..n {
            if !dx_valid[i] {
                continue;
            }
            if let Some(v) = smoothed[cursor] {
                adx_out[i] = Some(v);
            }
            cursor += 1;
        }
    }

    (plus_di, minus_di, adx_out)
}

/// 唐奇安通道：返回 (上轨, 下轨, 中轨)。不含当根 Bar，避免自我包含导致突破失效。
pub fn donchian(high: &[f64], low: &[f64], period: usize) -> (Vec<Option<f64>>, Vec<Option<f64>>, Vec<Option<f64>>) {
    let n = high.len();
    let mut upper = vec![None; n];
    let mut lower = vec![None; n];
    let mut mid = vec![None; n];
    if period == 0 || n <= period {
        return (upper, lower, mid);
    }
    for i in period..n {
        let hh = high[i - period..i].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let ll = low[i - period..i].iter().cloned().fold(f64::INFINITY, f64::min);
        upper[i] = Some(hh);
        lower[i] = Some(ll);
        mid[i] = Some((hh + ll) / 2.0);
    }
    (upper, lower, mid)
}

/// Williams %R（取值 -100~0）。
pub fn williams_r(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        let hh = high[i + 1 - period..=i].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let ll = low[i + 1 - period..=i].iter().cloned().fold(f64::INFINITY, f64::min);
        let range = hh - ll;
        out[i] = if range.abs() < f64::EPSILON {
            Some(-50.0)
        } else {
            Some((hh - close[i]) / range * -100.0)
        };
    }
    out
}

/// 动量：当前价与 N 日前价之差。
pub fn momentum(close: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = close.len();
    let mut out = vec![None; n];
    if period == 0 || n <= period {
        return out;
    }
    for i in period..n {
        out[i] = Some(close[i] - close[i - period]);
    }
    out
}

/// BIAS（乖离率，百分比）。
pub fn bias(close: &[f64], period: usize) -> Vec<Option<f64>> {
    let ma = sma(close, period);
    let n = close.len();
    let mut out = vec![None; n];
    for i in 0..n {
        if let Some(m) = ma[i] {
            if m.abs() > f64::EPSILON {
                out[i] = Some((close[i] - m) / m * 100.0);
            }
        }
    }
    out
}

/// 滚动最大 / 最小（含当根），常用于止损与区间判断。
pub fn rolling_max(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        out[i] = Some(values[i + 1 - period..=i].iter().cloned().fold(f64::NEG_INFINITY, f64::max));
    }
    out
}

pub fn rolling_min(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = values.len();
    let mut out = vec![None; n];
    if period == 0 || n < period {
        return out;
    }
    for i in (period - 1)..n {
        out[i] = Some(values[i + 1 - period..=i].iter().cloned().fold(f64::INFINITY, f64::min));
    }
    out
}

/// 滚动年化波动率（按 252 交易日）。
pub fn rolling_volatility(values: &[f64], period: usize) -> Vec<Option<f64>> {
    rolling_std(values, period)
        .into_iter()
        .map(|v| v.map(|s| s * 252f64.sqrt()))
        .collect()
}

/// 判定 `a` 在 `i` 处上穿 `b`（前一根在下方或持平，当根在上方）。
pub fn crossover(a: &[Option<f64>], b: &[Option<f64>], i: usize) -> bool {
    if i == 0 || i >= a.len() || i >= b.len() {
        return false;
    }
    match (a[i - 1], b[i - 1], a[i], b[i]) {
        (Some(a0), Some(b0), Some(a1), Some(b1)) => a0 <= b0 && a1 > b1,
        _ => false,
    }
}

/// 判定 `a` 在 `i` 处下穿 `b`。
pub fn crossunder(a: &[Option<f64>], b: &[Option<f64>], i: usize) -> bool {
    if i == 0 || i >= a.len() || i >= b.len() {
        return false;
    }
    match (a[i - 1], b[i - 1], a[i], b[i]) {
        (Some(a0), Some(b0), Some(a1), Some(b1)) => a0 >= b0 && a1 < b1,
        _ => false,
    }
}

/// 把 `Option` 序列中最后一个有效值取出（用于「当前值」判断）。
pub fn last_some(series: &[Option<f64>], i: usize) -> Option<f64> {
    series.get(i).copied().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn sma_matches_hand_computation() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        let out = sma(&v, 3);
        assert_eq!(out.len(), 5);
        assert_eq!(out[0], None);
        assert_eq!(out[1], None);
        assert!(approx(out[2].unwrap(), 2.0, 1e-9)); // (1+2+3)/3
        assert!(approx(out[3].unwrap(), 3.0, 1e-9));
        assert!(approx(out[4].unwrap(), 4.0, 1e-9));
    }

    #[test]
    fn ema_seed_and_recursion() {
        // 种子 = 前 3 个的均值 = 2；alpha = 2/4 = 0.5
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        let out = ema(&v, 3);
        assert!(approx(out[2].unwrap(), 2.0, 1e-9));
        // 4*0.5 + 2*0.5 = 3
        assert!(approx(out[3].unwrap(), 3.0, 1e-9));
        // 5*0.5 + 3*0.5 = 4
        assert!(approx(out[4].unwrap(), 4.0, 1e-9));
    }

    #[test]
    fn ema_constant_series_is_constant() {
        let v = vec![7.0; 50];
        let out = ema(&v, 10);
        for value in out.iter().flatten() {
            assert!(approx(*value, 7.0, 1e-9));
        }
    }

    #[test]
    fn sma_period_larger_than_data_returns_none() {
        let v = [1.0, 2.0];
        assert!(sma(&v, 5).iter().all(|x| x.is_none()));
        assert!(ema(&v, 5).iter().all(|x| x.is_none()));
        assert!(sma(&[], 3).is_empty());
    }

    #[test]
    fn wma_weights_favor_recent() {
        let v = [1.0, 2.0, 3.0];
        // 权重 1,2,3 -> (1*1 + 2*2 + 3*3) / 6 = 14/6
        let out = wma(&v, 3);
        assert!(approx(out[2].unwrap(), 14.0 / 6.0, 1e-9));
    }

    #[test]
    fn rma_recursion() {
        let v = [1.0, 2.0, 3.0, 4.0];
        let out = rma(&v, 2);
        // 种子 = (1+2)/2 = 1.5
        assert!(approx(out[1].unwrap(), 1.5, 1e-9));
        // (1.5*1 + 3)/2 = 2.25
        assert!(approx(out[2].unwrap(), 2.25, 1e-9));
        // (2.25*1 + 4)/2 = 3.125
        assert!(approx(out[3].unwrap(), 3.125, 1e-9));
    }

    #[test]
    fn rolling_std_sample_denominator() {
        let v = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        // 全序列均值 5，样本方差 = 32/7
        let out = rolling_std(&v, 8);
        assert!(approx(out[7].unwrap(), (32f64 / 7.0).sqrt(), 1e-9));
    }

    #[test]
    fn rsi_all_up_is_hundred() {
        let close: Vec<f64> = (0..30).map(|i| 100.0 + i as f64).collect();
        let out = rsi(&close, 14);
        let last = out.last().unwrap().unwrap();
        assert!(approx(last, 100.0, 1e-9));
    }

    #[test]
    fn rsi_all_down_is_zero() {
        let close: Vec<f64> = (0..30).map(|i| 100.0 - i as f64).collect();
        let out = rsi(&close, 14);
        let last = out.last().unwrap().unwrap();
        assert!(approx(last, 0.0, 1e-9));
    }

    #[test]
    fn rsi_warmup_is_none() {
        let close: Vec<f64> = (0..30).map(|i| 100.0 + (i % 3) as f64).collect();
        let out = rsi(&close, 14);
        assert_eq!(out[13], None);
        assert!(out[14].is_some());
    }

    #[test]
    fn macd_hist_zero_on_constant() {
        let close = vec![10.0; 80];
        let (dif, dea, hist) = macd(&close, 12, 26, 9);
        assert!(approx(dif[79].unwrap(), 0.0, 1e-9));
        assert!(approx(dea[79].unwrap(), 0.0, 1e-9));
        assert!(approx(hist[79].unwrap(), 0.0, 1e-9));
    }

    #[test]
    fn macd_dif_positive_in_uptrend() {
        let close: Vec<f64> = (0..120).map(|i| 10.0 + i as f64 * 0.5).collect();
        let (dif, _dea, _hist) = macd(&close, 12, 26, 9);
        assert!(dif[119].unwrap() > 0.0);
    }

    #[test]
    fn kdj_bounds_and_direction() {
        let close: Vec<f64> = (0..60).map(|i| 10.0 + i as f64).collect();
        let high: Vec<f64> = close.iter().map(|c| c + 0.5).collect();
        let low: Vec<f64> = close.iter().map(|c| c - 0.5).collect();
        let (k, d, j) = kdj(&high, &low, &close, 9, 3.0, 3.0);
        let kv = k[59].unwrap();
        // 持续新高时，K 应趋近 100
        assert!(kv > 90.0, "k = {kv}");
        assert!(d[59].unwrap() > 80.0);
        assert!(j[59].unwrap() > 90.0);
    }

    #[test]
    fn kdj_zero_range_no_nan() {
        let close = vec![5.0; 30];
        let high = vec![5.0; 30];
        let low = vec![5.0; 30];
        let (k, d, _j) = kdj(&high, &low, &close, 9, 3.0, 3.0);
        assert!(k[29].unwrap().is_finite());
        assert!(d[29].unwrap().is_finite());
    }

    #[test]
    fn boll_symmetric_bands() {
        let close: Vec<f64> = (0..40).map(|i| 10.0 + ((i % 5) as f64)).collect();
        let (mid, upper, lower) = boll(&close, 20, 2.0);
        let i = 30;
        let m = mid[i].unwrap();
        let u = upper[i].unwrap();
        let l = lower[i].unwrap();
        assert!(approx(u - m, m - l, 1e-9));
        assert!(u > l);
    }

    #[test]
    fn atr_constant_range() {
        // 每根 high-low = 2，且无跳空 -> TR 恒为 2，ATR 收敛到 2
        let high = vec![11.0; 60];
        let low = vec![9.0; 60];
        let close = vec![10.0; 60];
        let out = atr(&high, &low, &close, 14);
        assert!(approx(out[59].unwrap(), 2.0, 1e-9));
    }

    #[test]
    fn true_range_handles_gaps() {
        let high = [10.0, 15.0];
        let low = [8.0, 13.0];
        let close = [9.0, 14.0];
        let tr = true_range(&high, &low, &close);
        assert!(approx(tr[0], 2.0, 1e-9));
        // 第二根：max(2, |15-9|=6, |13-9|=4) = 6
        assert!(approx(tr[1], 6.0, 1e-9));
    }

    #[test]
    fn obv_accumulates_signed_volume() {
        let close = [10.0, 11.0, 10.5, 10.5, 11.0];
        let volume = [100.0, 200.0, 300.0, 400.0, 500.0];
        let out = obv(&close, &volume);
        assert!(approx(out[0].unwrap(), 0.0, 1e-9));
        assert!(approx(out[1].unwrap(), 200.0, 1e-9));
        assert!(approx(out[2].unwrap(), -100.0, 1e-9)); // 平盘不加不减
        assert!(approx(out[3].unwrap(), -100.0, 1e-9));
        assert!(approx(out[4].unwrap(), 400.0, 1e-9));
    }

    #[test]
    fn roc_percent() {
        let close = [100.0, 110.0, 121.0];
        let out = roc(&close, 1);
        assert!(approx(out[1].unwrap(), 10.0, 1e-9));
        assert!(approx(out[2].unwrap(), 10.0, 1e-9));
    }

    #[test]
    fn cci_zero_when_flat() {
        let high = vec![10.0; 30];
        let low = vec![10.0; 30];
        let close = vec![10.0; 30];
        let out = cci(&high, &low, &close, 20);
        assert!(approx(out[29].unwrap(), 0.0, 1e-9));
    }

    #[test]
    fn dmi_trend_has_high_plus_di() {
        let close: Vec<f64> = (0..80).map(|i| 10.0 + i as f64 * 0.5).collect();
        let high: Vec<f64> = close.iter().map(|c| c + 1.0).collect();
        let low: Vec<f64> = close.iter().map(|c| c - 1.0).collect();
        let (pdi, mdi, adx) = dmi(&high, &low, &close, 14, 14);
        assert!(pdi[79].unwrap() > mdi[79].unwrap());
        assert!(adx[79].unwrap() > 25.0, "adx = {:?}", adx[79]);
    }

    #[test]
    fn donchian_excludes_current_bar() {
        // period = 3 时，i 的窗口是 [i-3, i)，不含当根
        let high = [1.0, 2.0, 3.0, 10.0];
        let low = [1.0, 1.0, 1.0, 1.0];
        let (upper, lower, mid) = donchian(&high, &low, 3);
        assert_eq!(upper[2], None); // 数据不足，无预热值
        // i=3 窗口为 high[0..3] = [1,2,3]，当根 10 不应被计入
        assert!(approx(upper[3].unwrap(), 3.0, 1e-9));
        assert!(approx(lower[3].unwrap(), 1.0, 1e-9));
        assert!(approx(mid[3].unwrap(), 2.0, 1e-9));
    }

    #[test]
    fn williams_r_range() {
        let close = [10.0, 12.0, 11.0, 13.0, 14.0];
        let high = [11.0, 13.0, 12.0, 14.0, 15.0];
        let low = [9.0, 11.0, 10.0, 12.0, 13.0];
        let out = williams_r(&high, &low, &close, 3);
        for value in out.iter().flatten() {
            assert!(*value <= 0.0 && *value >= -100.0, "wr = {value}");
        }
    }

    #[test]
    fn crossover_detects_cross() {
        let a = vec![Some(1.0), Some(3.0), Some(4.0)];
        let b = vec![Some(2.0), Some(2.0), Some(2.0)];
        // i=1：a[0]=1 <= b[0]=2 且 a[1]=3 > b[1]=2 -> 上穿
        assert!(crossover(&a, &b, 1));
        // i=2：前一根已在上方，不再算上穿
        assert!(!crossover(&a, &b, 2));
        // 没有任何下穿
        assert!(!crossunder(&a, &b, 1));
        assert!(!crossunder(&a, &b, 2));
        // 预热期不误判
        assert!(!crossover(&[None, Some(1.0)], &[None, Some(2.0)], 1));
    }

    #[test]
    fn momentum_and_bias() {
        let close = [10.0, 12.0, 14.0];
        let m = momentum(&close, 2);
        assert!(approx(m[2].unwrap(), 4.0, 1e-9));
        let b = bias(&close, 2);
        // 均线 13，收盘 14 -> 7.69%
        assert!(approx(b[2].unwrap(), 1.0 / 13.0 * 100.0, 1e-9));
    }

    #[test]
    fn rolling_extremes() {
        let v = [3.0, 1.0, 4.0, 1.0, 5.0];
        let hi = rolling_max(&v, 3);
        let lo = rolling_min(&v, 3);
        assert!(approx(hi[4].unwrap(), 5.0, 1e-9));
        assert!(approx(lo[4].unwrap(), 1.0, 1e-9));
        assert!(approx(hi[2].unwrap(), 4.0, 1e-9));
    }
}
