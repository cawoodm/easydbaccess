When developing always:

- pull the branch
- increment the version (bump-version.mjs)

Gates - always prompt for feedback when making major decisions:

- Changing the database model
- Using new npm packages

When done report back:

- The new version number
- What was done (under 30 words)
- How to test it (under 30 words)
- Write/update an entry to TODO.md
- A link to the dev server

When the user confirms

- Add entry to CHANGELOG.md (short max 22 words)
- Update docs/ if necessary
- push
- If on main - publish to cawoodm.github.io/easydbaccess with the `npm run publish` command
