# Recording the demo

The README shows a headless browser capture of `pnpm demo:agent --backend claude-code --research`, made by `scripts/record-demo.ts`. This page is the script
for a real screen recording that can replace it: 60 seconds, one take, no narration needed.

## Set up (one command)

	pnpm install && pnpm demo

Wait for `Open the chat page`, then open the link it prints in a clean browser window at 1280 by 800: no bookmarks bar,
no extensions, and light mode. Leave the terminal visible on the left third of the screen, with a large font.

To show a real agent CLI instead of the scripted model, run `pnpm demo:agent --backend claude-code` on a Mac where
Claude Code is logged in. It uses the developer's own login, read for this demo only, and the agent may see public
(D0) data alone. Say so in the caption.

## Shot list

| Time | On screen | What it shows |
|---|---|---|
| 0 to 5 s | The terminal, with `pnpm demo` finishing: the handbook published, the worker and web door ready. | It runs on one machine with Docker and Node. |
| 5 to 18 s | The chat page. Click the first suggested question. The steps line shows `kb_search`, then `kb_read`. | The agent searches the lab's own documents. |
| 18 to 24 s | The answer, with its `Source` chip. Hover the chip. | Every answer names the entry it used. |
| 24 to 34 s | Type the second question, with the participant id `LAB0-0003`, and press Enter. | A message with restricted data. |
| 34 to 42 s | The yellow "Refused: restricted data" banner. Pause on it. | Nothing was sent to the hosted model, and the page says why. |
| 42 to 55 s | Click `Record` under the first answer. Scroll the run record slowly. | Every model call, tool call and refusal, with its data class. |
| 55 to 60 s | Hold on "Verified: chain intact". | The record is hash-chained, so an edit would show. |

## After recording

Trim to 60 seconds or less. Export an MP4 at 1280 wide and save it as `docs/images/demo.mp4`. Then make the README
GIF from it:

	ffmpeg -i docs/images/demo.mp4 -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" docs/images/demo.gif

Check the frames for anything personal before committing: the window title, the browser profile and any paths.
