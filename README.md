# System Design Simulator

An interactive lab for designing distributed systems, then loading, breaking and repairing them,
with every number coming from a deterministic simulation engine.

Drag components onto a canvas, connect them, and press **Start simulation**. Requests flow through
the architecture as animated traffic while live metrics update: throughput, mean and P95 latency,
error rate, queue depth, utilization and cache hit rate. Then break it: crash servers, kill the
database, spike traffic, add network latency, fail the cache, overload the queue. Watch the
failure propagate, recover, and see what recovery costs.

## What it models

The engine is a **deterministic fluid queueing simulation**. Traffic moves through the graph as
rates (requests per second, split into reads and writes) in fixed 100 ms ticks. There is no
randomness anywhere: the same design and the same actions always produce the same numbers, which
is what makes designs comparable and the engine testable.

| Mechanism | How it is modeled |
|---|---|
| Queueing delay | M/M/c waiting time (Sakasegawa's approximation), so latency climbs non-linearly toward saturation |
| Overload | Unserved demand waits in a bounded backlog; requests waiting past the timeout fail |
| Tail latency | Each path is a mixture of fixed plus exponential delays; P95 and P99 are solved from the mixture's distribution |
| Load balancing | Equal shares across targets still in rotation |
| Crashes and health checks | A dead instance keeps receiving its share of traffic until the health check removes it |
| Restarts | Instances take time to boot before rejoining |
| Databases | Every replica serves reads; only the primary takes writes, and capacity is shared |
| Caches | Absorb reads, never writes. They fail open to the database and come back cold, so the database takes a thundering herd while they refill |
| Queues | Producers get fast acknowledgements, consumer lag builds, failed jobs are redelivered (at-least-once), and producers are rejected when the queue is full |
| Retries | Clients retry failures, amplifying load on a struggling system |
| Failure propagation | Success probability composes along calls: healthy servers still fail when their database is down |

### Verified behaviour

The engine has its own test suite (`packages/engine/test`) that pins these behaviours to exact or
analytically expected values, for example:

- the queueing formula reduces to the exact M/M/1 result with one server;
- P95 of an exponential matches −ln(0.05) × mean;
- an overloaded service serves exactly its capacity and sheds the rest as timeouts;
- one of three instances crashing fails exactly a third of requests until the health check, then none;
- 2,400 writes/s on a 1,500 writes/s primary fails exactly 900/3,000 of traffic, however many read replicas are added;
- a cache outage moves the full read load onto the database, and recovery follows the cache's warm-up curve;
- a full queue rejects exactly the excess production rate.

A UI smoke test renders the whole app, runs it, injects every chaos experiment and runs an A/B
comparison.

## Features

- **Canvas**: drag-and-drop components (Client, CDN, API Gateway, Load Balancer, App Server,
  Redis, PostgreSQL, Kafka, Worker, Object Storage) with validated connections. Invalid links and
  cycles are refused, with the reason shown.
- **Live editing**: change instances, capacity, latency, failure rate, timeouts, hit rates or
  traffic while the simulation runs; state such as backlogs and dead instances carries over.
- **Chaos**: one-click experiments, plus per-component crash, latency and restart controls.
- **Analysis**: findings computed from the live state, such as "API servers is the bottleneck at
  100%: 5 instances would run at 70%", a write-bound database, single points of failure, consumer
  lag, or retry amplification.
- **Events**: a timeline of crashes, health-check removals, saturation and recoveries.
- **A/B comparison**: save two designs and run an identical scripted incident (3× spike, a crashed
  instance, recovery) against both. Results cover errors, P95, worst P95, throughput, queue depth,
  recovery time and estimated cost, with a plain-language verdict and overlaid charts.

## Architecture

```
packages/
  engine/   Pure TypeScript simulation. No UI or DOM dependency.
            types · catalog · validate · queueing · simulation · scenario · insights
  web/      React + TypeScript + React Flow. Drives the engine from requestAnimationFrame.
```

The UI never computes metrics; it renders snapshots from the engine. The engine is synchronous
and pure, so the same code runs the live view, the headless A/B scenarios and the tests.

## Running it

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + UI tests
npm run typecheck
npm run build      # single self-contained HTML file in packages/web/dist
```

## Limitations

- It is a model, not a packet-level simulator. Results show relative behaviour and failure modes,
  not production-accurate capacity planning.
- Load balancing is round-robin only. Cache-aside is drawn as Server → Redis → Database.
- Costs are rough on-demand estimates for comparing designs.

## Roadmap

1. **AI mentor**: a server-side endpoint that gives a model the live snapshot, the deterministic
   findings and the design as context. Answers must cite those numbers.
2. **Challenges**: URL shortener, chat, notifications and e-commerce, each with requirements,
   traffic targets and automatic pass/fail checks run by the scenario engine.
3. Circuit breakers, autoscaling, rate limiting and sharding as components.
