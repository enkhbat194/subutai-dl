# Operator notes

The dedicated workflow is intentionally isolated from the stable release workflow. It builds transient `0.1.0` and `0.2.0` packages from one commit, restores committed package versions after the run, serves the target feed only over loopback, and retains evidence for review.

Do not interpret branch creation, installer build success, or a cancelled workflow as acceptance. Only the two completed runtime outcomes—healthy target commit and watchdog rollback—count.
