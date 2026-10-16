# Notes for AI agents

## Pick the model to fit the task

Use cheaper, faster models (e.g. Sonnet or Haiku) for easier work, and keep the most capable model for the hard parts.

- **Cheaper model:** code reviews, verifying review findings, searching or reading through the code, running and reporting tests, docs and README edits, small mechanical changes.
- **Most capable model:** designing features, tricky debugging, and tuning the flocking simulation or the XR code paths.

When you hand work to subagents or workflows, set the cheaper model on the review, verify and search steps.
