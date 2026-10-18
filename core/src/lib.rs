//! Qbot 量化核心库。
//!
//! 定位（与项目架构一致）：
//! - 所有需要「三端原生运行」的计算都在这里：技术指标、策略信号、事件驱动回测、绩效分析；
//! - 只依赖标准库，不引入任何第三方 crate —— 这样同一份代码可以在 Linux / Windows / Android
//!   上编译，也便于用 `cargo test` 快速验证；
//! - 不做网络请求、不读数据库，输入输出都是普通 Rust 结构体，边界清晰。

pub mod backtest;
pub mod conditional;
pub mod risk;
pub mod indicators;
pub mod metrics;
pub mod optimizer;
pub mod strategies;
pub mod types;
