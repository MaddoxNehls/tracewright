# Example regression report

This is the PR comment `tracewright eval compare` produced for a real regression in the
research agent's dogfood suite ([`examples/research-agent/evals`](../examples/research-agent/evals)).
The regression is deliberate: `RESEARCH_AGENT_MOCK_DOUBLE_CHECK=1` makes the mock model
re-run its first tool call once more before carrying on. The answers don't change, but every
task takes one extra step, which costs tokens and money. Tasks with a tight `max_steps` budget
now fail, and the two with slack still pass but are flagged by the per-task `steps` threshold.

Reproduce it from `examples/research-agent`:

```sh
RESEARCH_AGENT_MOCK_DOUBLE_CHECK=1 uv run tracewright eval run evals/suite.yaml -o results.json
uv run tracewright eval compare --baseline evals/baseline.json --current results.json \
    --thresholds evals/thresholds.yaml \
    --dashboard-url https://tracewright.example.com --project demo   # exits 1
```

The dashboard URL is a placeholder; in CI the links point at the deployed dashboard. Both
runs here were made from the same commit, which is why the two SHAs match.

---

## Tracewright eval: `research-agent`

**Regression.** 4 tasks newly failing (allowed: 0); 2 tasks over a per-task threshold; suite passed tasks, cost (total), tokens (total), steps (total) over threshold. 2/6 tasks pass.

Baseline `4c049c57d58b` on `main` vs current `4c049c57d58b` on `main`; 1 run per task.

### Tasks

| task | change | baseline | current | steps | tokens | cost | latency | runs |
|---|---|---|---|---|---|---|---|---|
| `apollo-gap` | **newly failing** | pass | fail | **5 → 6** | 4,537 → 6,481 | **$0.01731 → $0.02370** | 14 ms → 15 ms | [compare](https://tracewright.example.com/p/demo/compare?a=27cc48f96f0e01f8177dcfc7911bfc64&b=af0f0aa44241fbb28017b72a37b85544) |
| `calculator-plain-numbers` | **newly failing** | pass | fail | **4 → 5** | 3,453 → 5,141 | **$0.01280 → $0.01846** | 6 ms → 5 ms | [compare](https://tracewright.example.com/p/demo/compare?a=1ebb49e1a87d36c89c859493e9ea597c&b=4d82a48b27c61a34f56d24dff8aed969) |
| `calculator-careful-model` | **newly failing** | pass | fail | **4 → 5** | 3,398 → 5,073 | **$0.01684 → $0.02434** | 5 ms → 6 ms | [compare](https://tracewright.example.com/p/demo/compare?a=b6899af06c61cd574e4221a24b53b96a&b=257e9c3b099ccdc97dab7f50db7e45b6) |
| `apollo-gap-careful-model` | **newly failing** | pass | fail | **5 → 6** | 4,537 → 6,481 | **$0.02308 → $0.03160** | 4 ms → 5 ms | [compare](https://tracewright.example.com/p/demo/compare?a=f0334751c21332fdd01bc9766f3ab571&b=58fdf6ca73f3094e0e2e5a3c69c455ab) |
| `calculator-recovery` | **regressed** | pass | pass | **5 → 6** | 4,667 → 6,656 | **$0.01706 → $0.02363** | 5 ms → 5 ms | [compare](https://tracewright.example.com/p/demo/compare?a=e876436035ba91c3b1b7a3399670610c&b=e193385b62f0e0d674a3ff65478742de) |
| `parallel-lookup` | **regressed** | pass | pass | **3 → 4** | 2,610 → 4,842 | **$0.01037 → $0.01803** | 4 ms → 5 ms | [compare](https://tracewright.example.com/p/demo/compare?a=cbcaeaf155bbc64d3453ea449ae82b04&b=f0f9bd16bda96db08d9d83752f41562c) |

### Suite metrics

| metric | baseline | current | change | threshold |
|---|---|---|---|---|
| passed tasks | 6 | 2 | -4 | **exceeded** (no decrease) |
| cost (total) | $0.09745 | $0.13976 | +$0.04231 (+43.4%) | **exceeded** (max +10%) |
| latency (p95) | 12 ms | 13 ms | +1 ms (+4.4%) | max +500 ms and +50% |
| tokens (total) | 23,202 | 34,674 | +11,472 (+49.4%) | **exceeded** (max +10%) |
| steps (total) | 26 | 32 | +6 | **exceeded** (no increase) |

### Failing checks

- `apollo-gap` (trace `af0f0aa44241fbb28017b72a37b85544`): `max_steps: 5` failed: 6 steps
- `calculator-plain-numbers` (trace `4d82a48b27c61a34f56d24dff8aed969`): `max_steps: 4` failed: 5 steps
- `calculator-careful-model` (trace `257e9c3b099ccdc97dab7f50db7e45b6`): `max_steps: 4` failed: 5 steps
- `apollo-gap-careful-model` (trace `58fdf6ca73f3094e0e2e5a3c69c455ab`): `max_steps: 5` failed: 6 steps
