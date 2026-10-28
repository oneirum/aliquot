# Sleep diary codebook

Synthetic document for the lab0 first-use check. Not a real study's codebook.

## Bedtime
bedtime is recorded in 24-hour clock format, HH:MM, as the participant reported it.

## Sleep latency
sleep_latency is the minutes from lights out to falling asleep. Values above 240 are flagged for review.

## Night wakings
wakings counts awakenings after sleep onset, an integer in the range 0 to 20.

## Missing values
A skipped item is coded -99 and a refused item is coded -98. Never leave a cell blank.

## Caffeine intake
caffeine_mg is the participant's estimate of caffeine after noon, in milligrams.

## Diary compliance
A diary day counts as complete when at least five of the seven items are answered before 10:00.

## Variable naming
Variable names are lowercase snake_case and carry the wave number as a suffix, for example sleep_latency_w2.
