// The guides `zamu instructions` prints (M6): an overview and three steps of the work on a task,
// bundled with the CLI so an agent reads the version that matches its zamu. AGENTS.md only points
// here (zamu agents), so the guidance changes with an upgrade, not with an edit in every repository.
import type { CliInstructionTopic } from '@zamu/contracts';

const OVERVIEW = `# Working with zamu

Tasks for this project live in Zamu. You read and change them with the zamu CLI. Every change
records who made it and the person an agent acts for, plus the machine and git branch it came from.

A task has a work record:
- Acceptance criteria: numbered lines that say what must be true when the task is done.
- Definition of done: checks every task in the project needs, such as tests and lint.
- Plan: how the work will be done, written when it starts.
- Work notes: short notes added while working.
- Final summary: what changed, how it was checked, and what is left.

The work, in three guides:
  zamu instructions creating     search first, then a task with testable criteria
  zamu instructions working      the plan, notes after each step, checking what is proven
  zamu instructions finishing    the final summary, In review, the final report

Basics:
  zamu whoami                                   who you act as, in which workspace, and which
                                                project applies here
  zamu tasks list --mine --status todo,in_progress
  zamu tasks show KEY                           the task, its work record and its history
  Add --json to any command for versioned output (zamu.v1.*).

Credentials: ZAMU_KEY (with ZAMU_URL), or the logins zamu login stores, one per workspace. In a clone
zamu picks the login whose workspace has this repository's project. zamu workspaces lists the logins;
--workspace <slug> picks one when a clone matches several (exit code 1, "matches 2 logins").

Rules:
- Search before you create a task. Two tasks for one piece of work split its history.
- Check an item only when you have proven it. Waive an item that no longer applies, with a reason.
- Stop at In review. A person, or the merge of the task's pull request, moves the task to Done.
- Zamu refuses an agent that moves a task to In review or Done while a criterion or done item is
  open (exit code 1, OPEN_ITEMS). The message lists each open item and the flags that settle it.
- If the server can't be reached, zamu may queue a write and exit with code 7. Name every queued
  write in your final report.
- In a project owned by Zamu, never write Backlog.md task files by hand. Tasks are in Zamu, and
  zamu backlog export writes the files. The backlog CLI is only for documents and decisions.
- In a project that still mirrors Backlog.md, the task files hold the work record. Change it in the
  files (or with backlog task edit) and push; zamu shows it read-only. Comments still go through zamu.

Exit codes: 0 ok, 1 usage or rejected input (OPEN_ITEMS too), 2 not logged in or key refused,
3 not found, 4 outside the key's scope, 5 server, 6 the change belongs in Backlog.md, 7 queued.
`;

const CREATING = `# Creating a task

1. Search first. Look for a task that already covers the work:
     zamu tasks list --project KEY --status backlog,todo,in_progress
   Read the likely matches with zamu tasks show KEY. Add to an existing task rather than open a
   second one.

2. Give it a short title that names the outcome: "Retry failed payouts", not "Work on payouts".

3. Write acceptance criteria that can be tested. Each one is a single line a reviewer can check with
   a command, a test or a look at the screen.
     Testable: "A failed payout is retried up to 8 times, 1 minute to 6 hours apart"
     Not testable: "Retries work well"
   Three to seven criteria is usual. When there are many more, split the task.

4. Create it:
     zamu tasks create "Retry failed payouts" --project KEY --description - \\
       --ac "A failed payout is retried up to 8 times, 1 minute to 6 hours apart" \\
       --ac "On-call is alerted once after the last attempt" < description.md
   The project's default done items are added for you. --dod "..." adds more, and
   --no-dod-defaults leaves the defaults out.

5. Leave the plan for later. It is written when the work starts, with what is known then.

Work you find outside the task's scope gets a task of its own; don't grow this one. --parent KEY
makes a subtask, and --blocked-by KEY records that it waits on another task.
`;

const WORKING = `# Working on a task

1. Start it and write the plan in one command, from the git branch you will work on:
     zamu tasks update KEY --status in_progress --plan - < plan.md
   The plan says how the work will be done: the steps, the files, the risks. It is Markdown.
   Replace it with --plan when it changes. zamu records the branch, so the pull request opened from
   it links to the task by itself.

2. Add a note after each step that changes something: what you did, what you found, what failed.
     zamu notes add KEY "Migration written and tested on a copy of the data"
     zamu tasks update KEY --check-ac 2 --append-notes "Retry schedule covered by tests"
   Keep notes short. They tell the next person, or your next session, where things stand.

3. Check criteria when you have proven them, not before:
     zamu tasks update KEY --check-ac 2
     zamu tasks update KEY --check-ac 3 --check-ac 4 --check-dod 1
   Several flags go in one request. --uncheck-ac N takes a check back.

4. Change the criteria when the work shows they were wrong, and say why in a note:
     zamu tasks update KEY --ac "Retries stop when the payout is canceled" --remove-ac 3
   Numbers are positions in the list. They shift after a removal, so read zamu tasks show KEY
   before the next change.

5. Waive an item that no longer applies, with the reason:
     zamu tasks update KEY --waive-ac 5 --reason "Load test replaced by a replay of last week's traffic"
   --unwaive-ac N takes a waiver back. --waive-dod N and --unwaive-dod N do the same for done items.

6. Comments are for people: questions, decisions, blockers. @name mentions someone.
     zamu comments add KEY "@ana Should refunds retry too?"

7. A pull request for several tasks links the others through its description: put a line such as
   "Closes: KEY-1, KEY-2" in it. zamu pr link KEY URL links a request by hand.

8. When the task waits on something outside your control, set a day to look again instead of
   leaving it In progress:
     zamu tasks update KEY --check-again 2026-12-03 --reason "Waiting for the bank's answer"
   --no-check-again clears it.

When you are blocked, say on what in a note or a comment.
`;

const FINISHING = `# Finishing a task

1. Read the record: zamu tasks show KEY. Every criterion and done item has to be checked or waived.

2. Check only what is proven. Run the tests, open the screen, read the output. An item you could
   not verify stays open: say so in the summary, or waive it with a reason a reviewer can judge.

3. Write the final summary:
     zamu tasks update KEY --final-summary - < summary.md
   Three short paragraphs at most: what changed, how you checked it, and what is left or waived and
   why. It is the first thing a reviewer reads.

4. Move the task to In review, not Done. A person reviews it and moves it to Done.
   One command can check the last items, write the summary and move the task:
     zamu tasks update KEY --check-ac 6 --final-summary - --status in_review < summary.md
   When the project closes on merge (zamu projects show), stop at In review: merging the pull
   request moves the task to Done.

5. If zamu answers OPEN_ITEMS (exit code 1), items are still open. The message lists each one with
   the flag that checks it and the flag that waives it. Settle them and move the task again. Never
   check an item only to get past the refusal.

6. In your final report, name the task, its status and anything left open. If zamu queued a write
   because the server was unreachable (exit code 7), list each queued write so a person can confirm
   it went through.

In a project owned by Zamu, the Backlog.md task files are a copy written by zamu backlog export.
Never edit them by hand and never run backlog task edit there. The backlog CLI is only for
documents and decisions.
`;

export const INSTRUCTIONS: Record<CliInstructionTopic, string> = {
  overview: OVERVIEW,
  creating: CREATING,
  working: WORKING,
  finishing: FINISHING,
};
