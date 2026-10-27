# Phased prompt: how to use

1. **If your IDE agent can read files in this project:** paste the contents of `00_PASTE_THIS_FIRST.md` as your first message. It tells the agent to read each phase file in `phases/` as it reaches that phase.
2. **If it cannot read files, or you want one paste:** paste `ALL_IN_ONE.md` (about 201 KB, the same content with all 20 phases inline). If your tool has a message-size limit, paste `00_PASTE_THIS_FIRST.md` first and each phase file when the agent asks for it.
3. The agent keeps its own state in `docs/build/DASH_PROGRESS.md`, so a new session can resume with the message: "Resume per section 8 of 00_PASTE_THIS_FIRST.md".
4. Keep `docs/backend-contract/` next to the dashboard code: it holds the OpenAPI contract, API index and Studio block schemas the agent builds against. Regenerate them from the backend repo when the backend changes.
