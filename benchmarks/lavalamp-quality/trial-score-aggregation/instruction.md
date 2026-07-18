# Repair benchmark trial scoring

Fix `scoreTrials` in `/app/src/score.ts`.

The benchmark score is the arithmetic mean of `reward` across every trial, including failed and timed-out trials. Return `0` when there are no trials. Do not change the exported types or add dependencies.
