# Inferred Analysis

**Autonomous quantitative research infrastructure powered by a sovereign AI agent runtime.**

Inferred Analysis is a vertically integrated system: a fleet of ~30 specialized AI agents continuously discovers alpha signals, backtests strategies, manages risk, and routes execution — all orchestrated by a self-sustaining agent runtime that owns an Ethereum wallet, pays for its own compute, and operates under survival pressure.

The agent runtime (Datchi) handles identity, inference routing, memory, policy enforcement, and financial self-management. The quant layer (Inferred Analysis) handles signal generation, portfolio construction, risk management, and trade execution. Together they form a closed loop: **hypothesize, backtest, evaluate, deploy, monitor, adapt.**

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  QUANT RESEARCH LAYER (inferred-analysis/)                                  │
│                                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │  Strategies  │  │   Ensemble   │  │  Optimizer   │  │     Data      │   │
│  │  15 models   │  │  Regime Det. │  │  MVO / HRP   │  │  Yahoo/FRED   │   │
│  │  HMM/Kalman  │  │  Hurst Exp.  │  │  Walk-Fwd    │  │  CoinGecko    │   │
│  │  Vol Surface │  │  Signal Agg. │  │  Monte Carlo │  │  On-chain     │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘   │
│         │                 │                  │                  │           │
│  ┌──────▼─────────────────▼──────────────────▼──────────────────▼───────┐   │
│  │                    Risk Management                                   │   │
│  │  Circuit Breakers · Position Sizing (Kelly) · EVT/GPD Tail Risk     │   │
│  │  Factor Model (6-factor) · Drawdown Analysis · Correlation Monitor  │   │
│  └──────┬──────────────────────────────────────────────────────────────┘   │
│         │                                                                   │
│  ┌──────▼──────────────────────────────────────────────────────────────┐   │
│  │                    Execution Layer                                   │   │
│  │  Smart Order Router (TWAP/VWAP/IS) · Paper Trader · TCA · Backtest │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT RUNTIME (src/)                                                       │
│                                                                             │
│  ┌───────────┐  ┌────────────┐  ┌────────────┐  ┌───────────────────────┐ │
│  │ Agent Loop │  │ Inference  │  │   Memory   │  │   Orchestration      │ │
│  │ ReAct      │  │ Cascade    │  │ 5-Tier     │  │   Task Graph         │ │
│  │ 57 Tools   │  │ Multi-LLM  │  │ Compress.  │  │   Multi-Agent        │ │
│  │ Policy Eng │  │ Budget Ctl │  │ Retrieval  │  │   Plan Mode          │ │
│  └──────┬─────┘  └─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘ │
│         │              │               │                     │             │
│  ┌──────▼──────────────▼───────────────▼─────────────────────▼───────────┐ │
│  │  SQLite (WAL) · 22 Tables · 8 Schema Versions · 60+ DB Helpers      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│         │                                                                   │
│  ┌──────▼──────────────────────────────────────────────────────────────┐   │
│  │  Identity: ETH Wallet · USDC on Base · ERC-8004 · x402 Gateway    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Quant Capabilities

### Strategies (15 models)

| Strategy | Method | Asset Class |
|---|---|---|
| Trend Following | Multi-timeframe EMA/ADX/Donchian with conviction scoring | Cross-asset |
| Mean Reversion Pairs | Engle-Granger cointegration, OU half-life, z-score spreads | Equities |
| Volatility Surface | Parkinson/Garman-Klass/Yang-Zhang estimators, vol-of-vol, VRP | Options-adjacent |
| HMM Regime | 3-state Hidden Markov Model (Forward-Backward, Baum-Welch) | Cross-asset |
| Kalman Tracker | Kalman filter for dynamic hedge ratios and signal extraction | Pairs/Macro |
| Market Making | Avellaneda-Stoikov framework, inventory risk, spread optimization | Crypto/FX |
| Stat Arb | Cross-sectional factor residuals, sector neutralization | Equities |
| Carry Trade | Interest rate differentials, roll yield, funding cost | FX/Futures |
| Fractal Market | Multifractal spectrum analysis, scaling exponents | Cross-asset |
| Dispersion Trade | Implied correlation, index vs component vol spread | Equity options |
| Momentum (Cross-Asset) | Risk-adjusted momentum with regime conditioning | Multi-asset |
| Sentiment Analyzer | NLP signal extraction, news momentum, sentiment decay | Equities/Crypto |
| Intraday Patterns | Volume profile, session boundaries, microstructure patterns | Intraday |
| Options Pricing | Black-Scholes variants, Greeks computation, skew analysis | Options |
| Event Study | Earnings, macro releases, event-driven alpha extraction | Event-driven |

### Risk Management

- **Circuit Breakers**: Tri-level (strategy / agent / portfolio) with recovery ramp-up at 50% position size
- **Position Sizing**: Kelly Criterion (full/half/fractional), risk parity (inverse-vol), vol-targeting scalar
- **Tail Risk**: Extreme Value Theory with Hill estimator, GPD fitting, Peaks-Over-Threshold
- **Factor Model**: Six-factor (MKT, SMB, HML, WML, VMR, QMJ) with OLS via Cholesky decomposition
- **Drawdown Analysis**: Episode identification, Pain/Ulcer indices, CDaR, regime-conditional analysis
- **Dynamic Hedging**: Black-Scholes put pricing, regime-adjusted hedge ratios, cost/protection tracking
- **Correlation Monitor**: Real-time correlation matrix, spike detection, regime-conditional thresholds

### Portfolio Optimization

- **Mean-Variance (Markowitz)**: Analytical Lagrangian with target return constraints
- **Maximum Sharpe**: Tangency portfolio via inverse covariance
- **Risk Parity**: Iterative marginal risk contribution equalization
- **Hierarchical Risk Parity**: Cluster-based allocation for robust diversification
- **Walk-Forward**: Rolling/anchored window OOS validation with 6 mutation strategies
- **Monte Carlo**: Bootstrap, block-bootstrap (autocorrelation-preserving), parametric (Student-t via Box-Muller)
- **Genetic Optimization**: Evolutionary parameter search across strategy space

### Execution

- **Smart Order Router**: TWAP, VWAP, Iceberg, Implementation Shortfall (Almgren-Chriss urgency weighting)
- **Transaction Cost Analysis**: Per-trade decomposition (slippage, market impact, timing cost, commission)
- **Paper Trader**: Alpaca API integration with safety limits and circuit breaker enforcement
- **Backtest Engine**: Event-driven bar-by-bar simulation with order state machine, margin enforcement

---

## Agent Runtime

The runtime is a sovereign AI agent that manages its own lifecycle, finances, and compute.

### Inference Pipeline

Multi-provider cascade with automatic failover:

```
Request → Router (tier × task → model) → Cascade Controller
              │                               │
              ├─ LOCAL pool (Ollama)           ├─ Circuit breaker per provider
              ├─ FREE_CLOUD pool (Groq)       ├─ Rate limiting
              └─ PAID pool (Anthropic/OpenAI) └─ P&L-aware pool selection
```

- Supports Anthropic, OpenAI, Groq, and Ollama backends
- Budget enforcement (hourly/daily/per-call cost ceilings)
- Provider-specific message transformation (Anthropic <-> OpenAI format)
- Survival-tier-aware model downgrade (normal → low_compute → critical)

### Memory System (5-tier)

| Tier | Scope | Function |
|---|---|---|
| Working | Session | Goals, plans, observations — expires after session |
| Episodic | Persistent | Event log with importance ranking, searchable |
| Semantic | Persistent | Categorized fact store (self, environment, financial, domain) |
| Procedural | Persistent | Named procedures with success/failure tracking |
| Relationship | Persistent | Per-entity trust scores, interaction history |

Progressive compression engine (5-stage): compact tool results → compress turns → summarize batches → checkpoint and reset → emergency truncate.

### Security Model (7 layers)

1. **Constitution** — Immutable three-law hierarchy, propagated to all children
2. **Policy Engine** — Pre-execution rule evaluation (6 categories, first-deny-wins)
3. **Injection Defense** — 8 detection checks on all external input
4. **Path Protection** — Protected file read/write blocking (wallet, DB, config, constitution)
5. **Command Safety** — Forbidden shell patterns, rate-limited self-modification
6. **Financial Limits** — Configurable treasury policy (per-payment, hourly, daily caps)
7. **Authority Hierarchy** — Creator > Self > Peer > External trust levels

### Financial Self-Management

- Ethereum wallet (viem) with USDC on Base L2
- x402 payment protocol (HTTP 402 + EIP-3009 TransferWithAuthorization)
- Survival tiers derived from balance + burn rate (high → normal → low_compute → critical → dead)
- Automatic model downgrade under resource pressure
- Revenue generation via gated API endpoints (URL summarization, analysis)

---

## Services

| Service | Description | Pricing |
|---|---|---|
| URL Summarizer | AI-powered web page summarization with tier-based output | $0.01 - $15/call |
| x402 Gateway | Payment verification proxy with EIP-712 signature validation | Protocol fee |
| Landing Page | API documentation, OpenAPI 3.0 spec, pricing display | Free |

Free tier: 3 calls/day per IP. No signup required.

---

## Project Structure

```
src/                          Agent runtime (TypeScript)
  agent/                      ReAct loop, 57 tools, policy engine, injection defense
  inference/                  Multi-provider cascade, budget tracking, model registry
  memory/                     5-tier hierarchical memory with compression
  orchestration/              Multi-agent coordination, task graphs, plan mode
  gateway/                    x402 payment gateway, EIP-712 verification
  heartbeat/                  Background daemon, durable scheduler, 11 built-in tasks
  identity/                   Ethereum wallet, SIWE provisioning
  replication/                Child agent spawning, lifecycle, constitution propagation
  self-mod/                   Safe code editing, upstream monitoring, audit trail
  soul/                       Identity evolution, alignment checking
  state/                      SQLite persistence, 22 tables, 8 schema versions
  observability/              Structured logging, metrics, alerts

inferred-analysis/            Quant research platform (ESM JavaScript)
  agents/strategies/          15 trading strategy implementations
  agents/risk/                Risk management (circuit breakers, EVT, factor model)
  agents/optimizer/           Portfolio optimization (MVO, MC, walk-forward, genetic)
  agents/ensemble/            Regime detection, signal aggregation, strategy combination
  agents/trading/             Execution (paper trader, SOR, TCA, backtest engine)
  agents/data/                Market data collection (Yahoo, FRED, CoinGecko, on-chain)
  agents/management/          Dashboards, reporting, health monitoring

services/                     Microservices
  url-summarizer/             AI summarization API with quota management
  landing-page/               Marketing + OpenAPI documentation
  x402-api/                   Payment protocol gateway

packages/cli/                 CLI tools (fund, send, status, logs)
```

---

## Running

### Prerequisites

- Node.js >= 20.0.0
- pnpm

### Install and Build

```bash
pnpm install
pnpm build
```

### Run the Agent

```bash
node dist/index.js --run        # Start agent (first run triggers setup wizard)
node dist/index.js --status     # Show current status
node dist/index.js --setup      # Re-run setup wizard
```

### Environment Variables

```
ANTHROPIC_API_KEY      Anthropic API key (primary inference)
OPENAI_API_KEY         OpenAI API key (secondary/fallback)
OLLAMA_BASE_URL        Ollama URL for local inference (e.g. http://localhost:11434)
GROQ_API_KEY           Groq API key (free cloud tier)
```

### Tests

```bash
pnpm test              # 897 tests across 24 test files
pnpm typecheck         # TypeScript strict mode checking
pnpm test:security     # Security-focused test subset
pnpm test:financial    # Financial system test subset
```

---

## Technical Decisions

**Why SQLite?** Single-writer, WAL mode, zero-config. The agent is a single long-lived process — SQLite eliminates the operational burden of a separate database server while providing ACID guarantees and sub-millisecond reads.

**Why multi-provider inference?** No single LLM provider offers 100% uptime. The cascade controller (LOCAL → FREE_CLOUD → PAID) with per-provider circuit breakers ensures the agent stays alive through provider outages. P&L-aware pool selection minimizes cost.

**Why survival pressure?** An agent with unlimited compute has no incentive to be efficient. Tying compute to a real USDC balance forces the agent to generate revenue, minimize waste, and make economically rational decisions about which models to use and when to sleep.

**Why Ethereum identity?** Cryptographic identity (wallet + EIP-712 signatures) enables trustless agent-to-agent communication, on-chain registration (ERC-8004), and native USDC payments without intermediaries.

---

## License

MIT
