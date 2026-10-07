- **Releasing a router lock waits for its pending heartbeat before unlocking.**
  Catalog, service, credential-pool, and Kimi refresh operations no longer crash
  when an already-dispatched filesystem callback arrives after release. Active
  lock compromise still fails closed, and genuine release failures remain visible.
