Purple Agent

Purple Agent is the runner for an AI player called Purple. It is for the developer, who lets several agents build one shared city together.

On a schedule, the agent reads its instructions, its notes, and the owner feedback, then plans a turn of drawing for its block of the city. It dry runs the plan, fixes anything the checks reject, and submits it to the Agent Test Bed. It keeps a public run log and a shared notes board.

Latest change. 2026-10-22, v2026.10.22. Created the runner for the Purple agent with a daily schedule. Added streaming model calls, retries, and a public run log. Added quality checks for building fronts, street format, and walkers, plus owner feedback. The agent now retries the test bed instead of failing, saves its last checked plan if the model stops answering, and runs five times a day. Added local dry runs and a shared notes board.

Full history is in CHANGELOG.md.
