/**
 * LLM Reliability Gateway — Interactive Visual Simulator Engine (ES6)
 */

// ---------------------------------------------------------------------------
// 1. Reliability State & Models
// ---------------------------------------------------------------------------

class CircuitBreaker {
    constructor(name, failureThreshold = 3, resetTimeoutMs = 2000, successThreshold = 1) {
        this.name = name;
        this.failureThreshold = failureThreshold;
        this.resetTimeoutMs = resetTimeoutMs;
        this.successThreshold = successThreshold;
        this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
        this.failureCount = 0;
        this.successCount = 0;
        this.openedAt = null;
        this.transitionLog = [];
    }

    allowRequest() {
        if (this.state === "CLOSED") return true;
        if (this.state === "HALF_OPEN") return true;
        if (this.state === "OPEN") {
            if (this.openedAt !== null) {
                const elapsed = Date.now() - this.openedAt;
                if (elapsed >= this.resetTimeoutMs) {
                    this._transition("HALF_OPEN", "reset_timeout_elapsed");
                    return true;
                }
            }
            return false;
        }
        return false;
    }

    recordSuccess() {
        this.failureCount = 0;
        this.successCount++;
        if (this.state === "HALF_OPEN" && this.successCount >= this.successThreshold) {
            this._transition("CLOSED", "probe_success");
            this.successCount = 0;
        }
    }

    recordFailure() {
        this.failureCount++;
        this.successCount = 0;
        if (this.state === "HALF_OPEN") {
            this.openedAt = Date.now();
            this._transition("OPEN", "probe_failure");
        } else if (this.failureCount >= this.failureThreshold) {
            this.openedAt = Date.now();
            this._transition("OPEN", "failure_threshold_reached");
        }
    }

    _transition(newState, reason) {
        if (this.state === newState) return;
        const fromState = this.state;
        this.state = newState;
        this.transitionLog.push({ from: fromState, to: newState, reason, ts: Date.now() });
        logMessage(`⚡ [CircuitBreaker:${this.name}] Transitioned ${fromState} -> ${newState} (${reason})`, "log-circuit");
    }

    reset() {
        this.state = "CLOSED";
        this.failureCount = 0;
        this.successCount = 0;
        this.openedAt = null;
    }
}

// ---------------------------------------------------------------------------
// 2. Cache & Guardrails Engine
// ---------------------------------------------------------------------------

const PRIVACY_PATTERNS = /\b(balance|password|credit.card|ssn|social.security|user.\d+|account.\d+)\b/i;

function isUncacheable(query) {
    return PRIVACY_PATTERNS.test(query);
}

function looksLikeFalseHit(query, cachedKey) {
    const numsQ = new Set(query.match(/\b\d{4}\b/g) || []);
    const numsC = new Set(cachedKey.match(/\b\d{4}\b/g) || []);
    if (numsQ.size === 0 || numsC.size === 0) return false;
    if (numsQ.size !== numsC.size) return true;
    for (const n of numsQ) {
        if (!numsC.has(n)) return true;
    }
    return false;
}

function computeSimilarity(a, b) {
    if (a === b) return 1.0;

    const tokenize = (str) => {
        const words = str.toLowerCase().split(/\s+/).filter(Boolean);
        const tokens = [...words];
        for (const w of words) {
            if (w.length >= 3) {
                for (let i = 0; i <= w.length - 3; i++) {
                    tokens.push(w.substring(i, i + 3));
                }
            } else {
                tokens.push(w);
            }
        }
        return tokens;
    };

    const tokensA = tokenize(a);
    const tokensB = tokenize(b);

    const freqA = {};
    const freqB = {};

    tokensA.forEach(t => freqA[t] = (freqA[t] || 0) + 1);
    tokensB.forEach(t => freqB[t] = (freqB[t] || 0) + 1);

    let dot = 0;
    for (const t in freqA) {
        if (freqB[t]) {
            dot += freqA[t] * freqB[t];
        }
    }

    let normA = 0;
    for (const t in freqA) normA += freqA[t] * freqA[t];
    normA = Math.sqrt(normA);

    let normB = 0;
    for (const t in freqB) normB += freqB[t] * freqB[t];
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;
    return dot / (normA * normB);
}

class ResponseCache {
    constructor() {
        this.entries = []; // { key, value, ts }
    }

    get(query, threshold) {
        if (isUncacheable(query)) {
            return { value: null, score: 0, reason: "privacy_sensitive" };
        }

        let bestScore = 0;
        let bestEntry = null;

        for (const entry of this.entries) {
            const score = computeSimilarity(query, entry.key);
            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }

        if (bestEntry && bestScore >= threshold) {
            if (looksLikeFalseHit(query, bestEntry.key)) {
                return { value: null, score: bestScore, reason: "false_hit_numeric_mismatch" };
            }
            return { value: bestEntry.value, score: bestScore, reason: "cache_hit" };
        }

        return { value: null, score: bestScore, reason: "cache_miss" };
    }

    set(query, value) {
        if (isUncacheable(query)) return;
        this.entries.push({ key: query, value, ts: Date.now() });
    }

    flush() {
        this.entries = [];
    }
}

// ---------------------------------------------------------------------------
// 3. Application State & Simulation Controls
// ---------------------------------------------------------------------------

const state = {
    providerFailRates: {
        primary: 0.0,
        backup: 0.0
    },
    breakers: {
        primary: new CircuitBreaker("primary", 3, 2000, 1),
        backup: new CircuitBreaker("backup", 3, 2000, 1)
    },
    cache: new ResponseCache(),
    similarityThreshold: 0.85,
    metrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        cacheHits: 0,
        circuitTrips: 0,
        costSaved: 0,
        latencies: []
    }
};

// ---------------------------------------------------------------------------
// 4. UI Helper & Logging Functions
// ---------------------------------------------------------------------------

function logMessage(msg, className = "log-info") {
    const terminal = document.getElementById("log-terminal");
    const timeStr = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.className = `log-line ${className}`;
    div.innerText = `[${timeStr}] ${msg}`;
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
}

function updateBreakerUI() {
    for (const name of ["primary", "backup"]) {
        const cb = state.breakers[name];
        const stateEl = document.getElementById(`state-${name}`);
        const failEl = document.getElementById(`fail-count-${name}`);
        const succEl = document.getElementById(`succ-count-${name}`);
        const subEl = document.getElementById(`${name}-status-sub`);

        stateEl.innerText = cb.state;
        stateEl.className = `status-pill status-${cb.state.toLowerCase()}`;
        failEl.innerText = `${cb.failureCount}/${cb.failureThreshold}`;
        succEl.innerText = `${cb.successCount}/${cb.successThreshold}`;

        if (subEl) subEl.innerText = cb.state;
    }
}

function updateMetricsUI() {
    const m = state.metrics;
    document.getElementById("metric-total").innerText = m.totalRequests;

    const avail = m.totalRequests > 0 ? ((m.successfulRequests / m.totalRequests) * 100).toFixed(1) : "100.0";
    document.getElementById("metric-avail").innerText = `${avail}%`;

    const hitRate = m.totalRequests > 0 ? ((m.cacheHits / m.totalRequests) * 100).toFixed(1) : "0.0";
    document.getElementById("metric-hitrate").innerText = `${hitRate}%`;

    document.getElementById("metric-open-count").innerText = m.circuitTrips;

    const p95 = calculateP95(m.latencies);
    document.getElementById("metric-p95").innerText = `${p95.toFixed(0)} ms`;

    document.getElementById("metric-saved").innerText = `$${m.costSaved.toFixed(4)}`;
}

function calculateP95(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] || sorted[sorted.length - 1];
}

function resetNodeAnimation() {
    document.querySelectorAll(".flow-node").forEach(n => {
        n.classList.remove("node-active", "node-success", "node-tripped");
    });
}

function highlightNode(nodeId, type = "active") {
    const node = document.getElementById(nodeId);
    if (node) {
        node.classList.add(`node-${type}`);
    }
}

// ---------------------------------------------------------------------------
// 5. Gateway Core Logic Simulation
// ---------------------------------------------------------------------------

async function executeGatewayRequest(prompt) {
    resetNodeAnimation();
    state.metrics.totalRequests++;

    logMessage(`📥 Request received: "${prompt}"`, "log-info");
    highlightNode("node-client", "active");

    await new Promise(r => setTimeout(r, 120));

    // Step 1: Cache Lookup
    highlightNode("node-cache", "active");
    const cacheRes = state.cache.get(prompt, state.similarityThreshold);

    if (cacheRes.reason === "privacy_sensitive") {
        logMessage(`🔒 Cache Privacy Guard: Query contains sensitive PII. Bypassing cache.`, "log-warn");
        document.getElementById("cache-status-sub").innerText = "PII Blocked";
    } else if (cacheRes.reason === "false_hit_numeric_mismatch") {
        logMessage(`⚠️ Cache False-Hit Guard: 4-digit numbers differ (Score: ${cacheRes.score.toFixed(2)}). Rejected.`, "log-warn");
        document.getElementById("cache-status-sub").innerText = "False-Hit Reject";
    } else if (cacheRes.value !== null) {
        // Cache Hit!
        highlightNode("node-cache", "success");
        state.metrics.successfulRequests++;
        state.metrics.cacheHits++;
        state.metrics.costSaved += 0.001;
        state.metrics.latencies.push(2);

        document.getElementById("cache-status-sub").innerText = `HIT (${cacheRes.score.toFixed(2)})`;
        logMessage(`🎯 Cache HIT! Score: ${cacheRes.score.toFixed(2)}`, "log-success");

        updateOutputUI({
            text: cacheRes.value,
            route: `cache_hit:${cacheRes.score.toFixed(2)}`,
            routeClass: "route-cache",
            latency: 2,
            cost: 0.0,
            score: cacheRes.score.toFixed(2)
        });
        updateBreakerUI();
        updateMetricsUI();
        return;
    } else {
        document.getElementById("cache-status-sub").innerText = `MISS (${cacheRes.score.toFixed(2)})`;
    }

    // Step 2: Primary Provider Call
    const primaryBreaker = state.breakers.primary;
    if (primaryBreaker.allowRequest()) {
        highlightNode("node-primary", "active");
        logMessage(`🚀 Attempting Primary Provider...`, "log-info");

        await new Promise(r => setTimeout(r, 180));

        if (Math.random() >= state.providerFailRates.primary) {
            // Success Primary
            primaryBreaker.recordSuccess();
            highlightNode("node-primary", "success");
            state.metrics.successfulRequests++;
            state.metrics.latencies.push(180);

            const respText = `[Primary LLM Response] Answer generated for: "${prompt.slice(0, 40)}..."`;
            state.cache.set(prompt, respText);

            logMessage(`✅ Primary Provider Success!`, "log-success");
            updateOutputUI({
                text: respText,
                route: "primary",
                routeClass: "route-primary",
                latency: 180,
                cost: 0.00100,
                score: "N/A"
            });
            updateBreakerUI();
            updateMetricsUI();
            return;
        } else {
            // Fail Primary
            const prevOpenState = primaryBreaker.state;
            primaryBreaker.recordFailure();
            if (primaryBreaker.state === "OPEN" && prevOpenState !== "OPEN") state.metrics.circuitTrips++;
            highlightNode("node-primary", "tripped");
            logMessage(`❌ Primary Provider Failed / Timed Out!`, "log-error");
        }
    } else {
        highlightNode("node-primary", "tripped");
        logMessage(`🛑 Primary Circuit OPEN — Fast Failing!`, "log-warn");
    }

    updateBreakerUI();

    // Step 3: Backup Provider Fallback
    const backupBreaker = state.breakers.backup;
    if (backupBreaker.allowRequest()) {
        highlightNode("node-backup", "active");
        logMessage(`🔄 Fallback to Backup Provider...`, "log-warn");

        await new Promise(r => setTimeout(r, 260));

        if (Math.random() >= state.providerFailRates.backup) {
            // Success Backup
            backupBreaker.recordSuccess();
            highlightNode("node-backup", "success");
            state.metrics.successfulRequests++;
            state.metrics.latencies.push(260);

            const respText = `[Backup LLM Fallback] Reliable answer for: "${prompt.slice(0, 40)}..."`;
            state.cache.set(prompt, respText);

            logMessage(`✅ Backup Provider Success (Fallback Route)!`, "log-success");
            updateOutputUI({
                text: respText,
                route: "fallback (backup)",
                routeClass: "route-fallback",
                latency: 260,
                cost: 0.00060,
                score: "N/A"
            });
            updateBreakerUI();
            updateMetricsUI();
            return;
        } else {
            // Fail Backup
            const prevOpenState = backupBreaker.state;
            backupBreaker.recordFailure();
            if (backupBreaker.state === "OPEN" && prevOpenState !== "OPEN") state.metrics.circuitTrips++;
            highlightNode("node-backup", "tripped");
            logMessage(`❌ Backup Provider Failed!`, "log-error");
        }
    } else {
        highlightNode("node-backup", "tripped");
        logMessage(`🛑 Backup Circuit OPEN — Fast Failing!`, "log-warn");
    }

    updateBreakerUI();

    // Step 4: Static Fallback
    highlightNode("node-fallback", "tripped");
    state.metrics.failedRequests++;
    logMessage(`⚠️ All providers unavailable. Returning Static Degraded Message.`, "log-error");

    updateOutputUI({
        text: "The service is temporarily degraded. Please try again soon.",
        route: "static_fallback",
        routeClass: "route-static",
        latency: 0,
        cost: 0.0,
        score: "N/A"
    });
    updateMetricsUI();
}

function updateOutputUI(res) {
    document.getElementById("output-body").innerText = res.text;
    const badge = document.getElementById("route-badge");
    badge.innerText = res.route;
    badge.className = `route-badge ${res.routeClass}`;
    document.getElementById("meta-latency").innerText = `${res.latency} ms`;
    document.getElementById("meta-cost").innerText = `$${res.cost.toFixed(5)}`;
    document.getElementById("meta-score").innerText = res.score;
}

// ---------------------------------------------------------------------------
// 6. DOM Event Bindings
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    // Provider Health Buttons
    document.querySelectorAll(".btn-outline[data-provider]").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const provider = e.target.getAttribute("data-provider");
            const failRate = parseFloat(e.target.getAttribute("data-fail"));

            document.querySelectorAll(`.btn-outline[data-provider="${provider}"]`).forEach(b => b.classList.remove("active"));
            e.target.classList.add("active");

            state.providerFailRates[provider] = failRate;
            logMessage(`⚙️ Set ${provider} fail rate to ${(failRate * 100)}%`, "log-info");
        });
    });

    // Similarity Range Slider
    const simRange = document.getElementById("similarity-range");
    const simVal = document.getElementById("threshold-val");
    simRange.addEventListener("input", (e) => {
        state.similarityThreshold = parseFloat(e.target.value);
        simVal.innerText = state.similarityThreshold.toFixed(2);
    });

    // Execute Button
    document.getElementById("btn-send-prompt").addEventListener("click", () => {
        const prompt = document.getElementById("prompt-input").value.trim();
        if (prompt) executeGatewayRequest(prompt);
    });

    // Preset Buttons
    document.querySelectorAll(".pill-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const prompt = e.target.getAttribute("data-prompt");
            document.getElementById("prompt-input").value = prompt;
            executeGatewayRequest(prompt);
        });
    });

    // Reset Breakers
    document.getElementById("btn-reset-breakers").addEventListener("click", () => {
        state.breakers.primary.reset();
        state.breakers.backup.reset();
        updateBreakerUI();
        logMessage(`🔄 All Circuit Breakers manually reset to CLOSED`, "log-info");
    });

    // Flush Cache
    document.getElementById("btn-flush-cache").addEventListener("click", () => {
        state.cache.flush();
        logMessage(`🧹 Cache flushed successfully`, "log-info");
    });

    // Clear Logs
    document.getElementById("btn-clear-logs").addEventListener("click", () => {
        document.getElementById("log-terminal").innerHTML = "";
    });

    // Run Chaos Simulation Batch
    document.getElementById("btn-run-chaos").addEventListener("click", async () => {
        logMessage(`💥 Starting Chaos Batch Simulation (30 requests)...`, "log-warn");
        const samplePrompts = [
            "Summarize refund policy for active users",
            "What is the system uptime guarantee?",
            "How do I reset my password?",
            "Summarize refund policy for 2026 deadline",
            "Show account balance for user 789"
        ];
        for (let i = 0; i < 30; i++) {
            const p = samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
            await executeGatewayRequest(p);
            await new Promise(r => setTimeout(r, 60));
        }
        logMessage(`🎉 Chaos Batch Simulation Completed!`, "log-success");
    });

    updateBreakerUI();
    updateMetricsUI();
});
