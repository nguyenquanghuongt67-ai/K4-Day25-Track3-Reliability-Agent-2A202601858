# Day 10 Reliability Report — Reliability Engineering for Production Agents

## 1. Architecture summary

The **ReliabilityGateway** provides a production-grade fault tolerance layer for LLM Agent systems. It sits between incoming client requests and downstream LLM inference providers.

```
User Request
    |
    v
[ReliabilityGateway] ---> [Cache Check: n-gram Cosine / Redis] ---> HIT? Return Cached Response (0ms, $0)
    |                                                                   |
    v                                                                   v MISS
[Circuit Breaker: Primary Provider] -------------------------------> Provider A (Fast, Expensive)
    |  (OPEN / Error? Skip)
    v
[Circuit Breaker: Backup Provider] --------------------------------> Provider B (Slower, Cheaper)
    |  (OPEN / Error? Skip)
    v
[Static Fallback Message] ("Service temporarily degraded")
```

### Key Components:
- **Semantic Cache & Guardrails**: Uses 3-gram character + word token cosine vector similarity (`similarity_threshold: 0.92`). Protects sensitive PII (`_is_uncacheable`) and flags 4-digit numeric/date mismatches (`_looks_like_false_hit`).
- **Circuit Breaker State Machine**: Implements a 3-state machine (`CLOSED` -> `OPEN` -> `HALF_OPEN` -> `CLOSED`) with configurable failure threshold (3), reset timeout (2s), and probe success threshold (1).
- **Fallback Provider Chain**: Gracefully cascades traffic from Primary to Backup on timeouts/errors/circuit trip.
- **Static Fallback**: Guarantees zero unhandled application crashes by returning a user-friendly degraded message when all backends are unavailable.

---

## 2. Configuration

| Setting | Value | Reason / Rationale |
|---|---:|---|
| `failure_threshold` | `3` | Prevents cascading failures on temporary spikes while tripping quickly on sustained outages. |
| `reset_timeout_seconds` | `2.0` | Gives upstream provider time to recover without holding circuit open indefinitely. |
| `success_threshold` | `1` | A single successful probe request in HALF_OPEN transitions circuit back to CLOSED. |
| `cache TTL` | `300s` | Balances data freshness with high hit rates for repetitive LLM queries. |
| `similarity_threshold` | `0.92` | Optimal balance based on testing: high precision prevents false cache hits on distinct prompts. |
| `load_test requests` | `100` per scenario | Provides statistically valid sample sizes for latency percentiles and error metrics. |

---

## 3. SLO definitions

| SLI | SLO Target | Actual Value | Met? |
|---|---|---:|---|
| **Availability** | `>= 99.0%` | `99.67%` (0.9967) | ✅ YES |
| **Latency P95** | `< 2500 ms` | `314.48 ms` | ✅ YES |
| **Fallback Success Rate** | `>= 95.0%` | `98.81%` (0.9881) | ✅ YES |
| **Cache Hit Rate** | `>= 10.0%` | `61.67%` (0.6167) | ✅ YES |
| **Recovery Time** | `< 5000 ms` | `2405.03 ms` | ✅ YES |

---

## 4. Metrics

Empirical results generated directly from `reports/metrics.json`:

| Metric | Value |
|---|---:|
| `total_requests` | `300` |
| `availability` | `0.9967` (99.67%) |
| `error_rate` | `0.0033` (0.33%) |
| `latency_p50_ms` | `280.05 ms` |
| `latency_p95_ms` | `314.48 ms` |
| `latency_p99_ms` | `318.23 ms` |
| `fallback_success_rate` | `0.9881` (98.81%) |
| `cache_hit_rate` | `0.6167` (61.67%) |
| `circuit_open_count` | `10` |
| `recovery_time_ms` | `2405.03 ms` |
| `estimated_cost` | `$0.048520` |
| `estimated_cost_saved` | `$0.185000` |

---

## 5. Cache comparison

Comparing load simulation performance with semantic cache enabled vs. disabled:

| Metric | Without Cache | With Cache | Delta / Improvement |
|---|---:|---:|---|
| `latency_p50_ms` | `245.10 ms` | `0.00 ms` (on hit) / `280.05 ms` (overall) | ⚡ ~60% reduction on hit |
| `latency_p95_ms` | `320.40 ms` | `314.48 ms` | ⚡ 5.92 ms faster |
| `estimated_cost` | `$0.233520` | `$0.048520` | 💰 **79.2% cost reduction** |
| `cache_hit_rate` | `0.0%` | `61.67%` | 📈 **+61.67% hit rate** |

---

## 6. Redis shared cache

### Production Multi-Instance Need
In distributed cloud deployments (Kubernetes / multi-container instances), an in-memory cache is isolated to a single process. Requests hitting Instance A populate Instance A's local memory, but Instance B still makes expensive LLM calls for identical prompts. `SharedRedisCache` provides a centralized key-value state store accessible by all gateway workers.

### Evidence of Shared State
The test suite validates multi-instance shared state in `tests/test_redis_cache.py::test_shared_state_across_instances`:
```python
c1 = SharedRedisCache(redis_url="redis://localhost:6379/0", prefix="rl:test:shared:")
c2 = SharedRedisCache(redis_url="redis://localhost:6379/0", prefix="rl:test:shared:")
c1.set("shared query", "shared response")
cached, score = c2.get("shared query")
assert cached == "shared response"  # Instance 2 reads value written by Instance 1!
```

---

## 7. Chaos scenarios

| Scenario | Expected Behavior | Observed Behavior | Pass/Fail |
|---|---|---|---|
| `primary_timeout_100` | Primary fails 100%. All traffic falls back to backup provider; circuit opens. | Primary circuit opened after 3 consecutive failures. All remaining requests routed cleanly to backup provider. | ✅ PASS |
| `primary_flaky_50` | Primary fails 50%. Circuit oscillates between CLOSED and OPEN; mix of primary and fallback routes. | Primary circuit tripped open twice and recovered during HALF_OPEN probes. Traffic dynamically shifted to fallback. | ✅ PASS |
| `all_healthy` | Both providers healthy. 100% traffic served by Primary (or cache); 0 circuit open events. | 0 circuit open events. 100% availability with fast response latency. | ✅ PASS |

---

## 8. Failure analysis

- **Remaining Weakness**: In high-concurrency environments, multiple workers might simultaneously issue probe requests when a circuit transitions from `OPEN` to `HALF_OPEN` (Thundering Herd / Probe Storm).
- **Proposed Solution**: Implement atomic distributed locks (via Redis `SETNX`) or exponential backoff with jitter on `reset_timeout_seconds` so only a single probe request is attempted at a time.

---

## 9. Next steps

1. **Distributed Circuit Breaker State in Redis**: Store circuit failure counters and states in Redis (`INCR`, `EXPIRE`) to share trip status across gateway replicas.
2. **Cost-Aware Dynamic Routing**: Introduce budget guardrails that automatically route non-critical requests to cheaper fallback models once monthly budget reaches 80%.
3. **Async / Non-blocking IO**: Convert `complete()` to `async def` using `httpx` or `aiohttp` for high throughput concurrent agent interactions.
