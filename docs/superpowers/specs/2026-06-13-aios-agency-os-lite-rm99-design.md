# aios agency os lite rm99 design

date: 2026-06-13
status: draft for launch
owner: firaz / aios

## decision

launch the first commercial aios package as **aios agency os lite** at **rm99/month**.

the customer is a solo or small agency owner who already sells services but is drowning in delivery, proposals, follow-ups, reporting, and daily prioritization. the product is not sold as generic automation. it is sold as an ai agency operator that helps the owner produce more output before hiring.

## positioning

headline:

> run your agency with an ai operator for rm99/month

promise:

> aios learns your services, clients, tasks, and delivery workflow, then helps you create proposals, content, reports, follow-ups, and daily priorities from one desktop app.

demo hook:

> watch aios turn one messy client request into a proposal, task list, content plan, invoice draft, and client reply.

## first customer profile

target:

- solo agency founders
- smma owners
- freelance designers with recurring clients
- web/dev/creative studios with 1-5 people
- new agency owners like rais who need operating leverage

do not target broad "business owners" in v1. the agency wedge is tighter, easier to demo, and easier to resell through.

## packaging

### rm99/month: agency os lite

included:

- 1 agency workspace
- 3 client workspaces
- agency onboarding wizard
- proposal generator
- client onboarding checklist
- content idea and caption generator
- daily agency briefing
- task planner
- whatsapp reply drafts
- report draft generator
- reusable prompts and workflows
- local-first aios shell experience

not included:

- done-for-you setup
- custom integrations
- unlimited clients
- personal support
- complex automations
- custom agent building

### upgrade paths

rm299/month: agency os pro

- 10 client workspaces
- whatsapp/email/docs integrations where available
- richer client memory
- weekly reporting pack
- priority templates

rm799 setup: founder install

- one guided onboarding call
- configure actual services, client types, offer library, and operating rhythm
- convert their common tasks into aios workflows

rm2,500+ transformation:

- custom agency operating system
- deeper integrations
- two weeks of support
- workflow buildout for the founder and team

## product spine

the v1 product is the onboarding wizard plus the workspace it generates. the app must make the owner feel like aios understands their agency within the first session.

the wizard collects:

1. agency name
2. founder name
3. main services sold
4. primary niche or client type
5. current number of active clients
6. monthly revenue range
7. team size
8. highest margin service
9. most painful delivery task
10. most painful sales task
11. where leads come from
12. where client conversations happen
13. current proposal format
14. current reporting format
15. weekly recurring deliverables
16. common client objections
17. tone of voice for client replies
18. preferred working hours
19. top 3 clients to load first
20. what would make aios worth rm99 in the first 7 days

## generated workspace

after onboarding, aios creates these surfaces:

- agency profile: services, niche, offers, tone, client types
- client list: first 3 client workspaces
- command center: today's priorities, stuck items, follow-ups
- sales kit: proposal outline, objection responses, follow-up drafts
- delivery kit: content plan, task list, checklist, report draft
- daily briefing: what needs attention today
- operator prompts: reusable commands for agency work

## core workflows

### messy request to delivery plan

input: pasted whatsapp/client message

output:

- clean summary
- reply draft
- action items
- deliverables
- deadline questions
- internal task list

### proposal draft

input: prospect notes, service type, budget range

output:

- problem summary
- recommended package
- scope
- timeline
- price anchor
- next-step message

### client report draft

input: notes, wins, metrics, completed work

output:

- client-friendly report
- next month plan
- blockers
- upsell opportunity

### daily agency briefing

input: agency profile, clients, tasks, recent notes

output:

- top 3 priorities
- overdue follow-ups
- delivery risks
- sales opportunities
- suggested first action

## success criteria

first 10 beta users:

- 7 complete onboarding
- 5 generate at least one proposal/report/client reply
- 3 say it saves at least 5 hours in the first week
- 2 convert to paid rm99/month after trial

product activation:

- time to first useful output under 15 minutes
- onboarding completion under 30 minutes
- no more than 20 required questions
- user can understand the value without custom support

## launch assets

needed before selling:

- one-page landing page
- stripe/billplz payment link or equivalent
- 3-minute demo using adletic workflow
- onboarding wizard copy
- rm99 checkout offer
- cancellation/refund language
- beta user tracking sheet

## implementation boundaries

v1 should reuse existing aios shell primitives: chat, notes, files, local memory, and command surfaces. avoid building a full crm, full billing system, or heavy team workspace before paid users validate the wedge.

the first technical milestone is not "complete agency platform". it is "a founder can install/open aios, answer the wizard, and get useful agency outputs immediately."

## risks

- rm99 is too low for high-touch support, so self-serve must be strict.
- users may ask for integrations too early; pro/setup tiers absorb that demand.
- broad business-owner positioning will dilute the product. stay agency-first until the playbook is repeatable.
- if the wizard feels like a form instead of an interview, activation will drop.

## next step

create the implementation plan for the agency onboarding wizard and generated workspace inside aios shell.
