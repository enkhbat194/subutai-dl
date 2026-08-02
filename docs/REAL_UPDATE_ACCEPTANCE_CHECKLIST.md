# Real update acceptance completion checklist

The package is complete only when the exact pull-request head passes all of the following on the `subutai-windows` self-hosted runner:

- acceptance safety policy
- TypeScript typecheck
- updater transaction and rollback policy tests
- existing local two-build fixture regressions
- real baseline NSIS Setup build (`0.1.0`)
- real target NSIS Setup build (`0.2.0`)
- loopback-only generic update feed
- healthy installed update to `0.2.0`
- committed startup health journal
- verified previous installer cache
- preservation sentinels for settings, queue, database, `.subutai.part`, and `.subutai.job`
- Chrome, Edge, and Firefox native-messaging registration
- test-only target startup health failure
- watchdog rollback to the exact baseline executable hash
- successful one-attempt rollback journal
- preservation checks after rollback
- final silent uninstall
- evidence artifact tied to the exact tested commit SHA

A cancelled run is not evidence. A failed run must be diagnosed from its full job log and rerun on the corrected commit. No tag, GitHub Release, publish, deployment, or merge is part of this workflow.
