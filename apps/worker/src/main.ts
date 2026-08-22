const workerId = process.env.WORKER_ID ?? "worker-local-1";
const roles = (process.env.WORKER_ROLES ?? "pm,pe,coder,qa").split(",");

console.log(JSON.stringify({
  event: "worker.started",
  workerId,
  roles,
  occurredAt: new Date().toISOString(),
}));

setInterval(() => {
  console.log(JSON.stringify({ event: "worker.heartbeat", workerId, occurredAt: new Date().toISOString() }));
}, 15_000);
