# Tracewright agent eval (composite action)

Runs a [Tracewright](../../../sdk/python/README.md#regression-evals) eval suite, compares
the results with a committed baseline, and:

- writes the markdown report to the job summary,
- posts it as one PR comment, which later pushes update in place (found by a hidden marker),
- fails the step when the comparison finds a regression.

The `tracewright` Python package must already be installed in the project being evaluated,
and the suite's entrypoint importable from `working-directory`.

```yaml
permissions:
  contents: read
  pull-requests: write   # for the comment

steps:
  - uses: actions/checkout@v4
  - uses: astral-sh/setup-uv@v6
  - run: uv sync --locked
  - uses: MaddoxNehls/tracewright/.github/actions/agent-eval@main
    with:
      command: uv run tracewright
      suite: evals/suite.yaml
      baseline: evals/baseline.json
      thresholds: evals/thresholds.yaml
```

From another repository this needs read access to this one; within this repo the
[`agent-eval`](../../workflows/agent-eval.yml) workflow uses it as `./.github/actions/agent-eval`.

## Inputs

| input | default | |
|---|---|---|
| `suite` | (required) | suite YAML, relative to `working-directory` |
| `baseline` | (required) | baseline results JSON, relative to `working-directory` |
| `thresholds` | none | thresholds YAML; without one, any newly failing task is a regression |
| `working-directory` | `.` | where to run, usually the agent project's root |
| `command` | `tracewright` | how to invoke the CLI there, e.g. `uv run tracewright` |
| `repeat` | `1` | runs per task; more than 1 reports flaky tasks |
| `dashboard-url` | none | dashboard base URL, to link each regressed task's two runs |
| `project` | none | Tracewright project slug for those links |
| `comment` | `true` | post or update the PR comment |
| `fail-on-regression` | `true` | fail the step on regression |
| `github-token` | `github.token` | token for the comment |

Set `TRACEWRIGHT_API_KEY` (and `TRACEWRIGHT_ENDPOINT`) in the job's environment to also
send the eval runs to Tracewright. Dashboard links only resolve for traces that were sent,
so record the baseline with a key too if you want working links.

## Outputs

| output | |
|---|---|
| `regression` | `"true"` or `"false"` |
| `results` | path of this run's results JSON (e.g. to upload as the next baseline) |
| `report` | path of the markdown report |

Commenting is best-effort (`continue-on-error`): on pull requests from forks the token is
read-only, so the comment step fails without failing the job, and the report is still in
the job summary. A regression still fails the job.

## Updating the baseline

After an intended behaviour change, regenerate the baseline and commit it with the change:

```sh
tracewright eval run evals/suite.yaml -o evals/baseline.json
```
