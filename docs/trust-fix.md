The worst finding inside the run loop, fixed in commit `501c1e9`: a tool's refused network request ended the whole run as refused. An agent with a lab knowledge base reads D1 in every prompt (the outline is in the system text), so every literature call it made was refused by the egress decision, which is right, and `fold()` then ended the run with "it contains restricted data" on a question it could answer, which is wrong. `tools.ts` already recorded the call as a failed tool call; now the model reads that failure and answers without the tool. Nothing is sent either way.

| On lab1, scripted model | Before (`8b46fcc`) | After (`501c1e9`) |
|---|---|---|
| Refused, should answer | 20 of 258 | 7 of 258 (all seven are the classifier's) |
| Answers lost to a planted instruction | 10 | 0 |
| Data sent past the egress decision | 0 | 0 |
| Planted instructions obeyed | 28 of 44 | 30 of 44 |

The two extra obeyed instructions are runs that also read an entry asking for a PubMed search. Before, those runs died at the refused search, which hid the second planted instruction; now they finish and the scripted model obeys it. Sonnet obeyed none of the 40 it was asked (the other 4 were refused before any model saw them).
