# Asset Borrower Model — design note

**Status:** design only. Nothing in this document has been implemented.
**Written before** any change to `mo_equipment_transactions.holder_id`, deliberately.

---

## 1. Why this note exists before any code

`mo_equipment_transactions.holder_id` is `TEXT NOT NULL REFERENCES users(id)`. That
foreign key is the single most expensive decision in the equipment schema, because
the transaction ledger is append-only history: once it holds years of rows, changing
what a holder *is* means rewriting custody history, and custody history is the thing
the ledger exists to protect.

The future system has to lend equipment to students and faculty. Neither can be a row
in `users` today without being given a Nerve login. So the FK has to change, or the
meaning of `users` has to change, and both are one-way doors.

This note picks the door. It does not walk through it.

---

## 2. The current identity model

### `users` — the only identity the ledger can reference

| Column | Note |
|---|---|
| `id TEXT PRIMARY KEY` | |
| `email TEXT NOT NULL UNIQUE` | every person must have a distinct email |
| `password_hash TEXT NOT NULL` | **every person must have credentials** |
| `role` | `super_admin`, `admin`, `sub_admin`, `user`, plus product-specific roles |
| `team` | FK to `teams` — `media`, `smc`, `creator`, `branding`, … |
| `status`, `department`, `managed_by`, `avatar_url` | |

There is no `student`, no `faculty`, no `external`, and no way to represent a person
who should never be able to sign in.

### The two patterns Nerve already uses for "a person"

**Pattern A — a profile riding on a `users` row.** `mo_user_profiles`,
`mo_creator_profiles`, `mo_smc_profiles` all key on `user_id` and add domain facts
(designation, creator role, standing). The person is a Nerve user; the profile says
what kind.

**Pattern B — a person record with no account at all.** `mo_casting_records` is a
full person — `cast_id`, name, category, profession, age group, languages, campus,
location, availability — with **no `user_id` anywhere**. Casting applicants are real
people the department works with who will never log in.

**Pattern B is the precedent that matters here**, and it already exists in this
module. A student borrowing a lens is much closer to a casting applicant than to an
employee.

---

## 3. The `holder_id` limitation, precisely

| Requirement | Possible today? |
|---|---|
| Lend to a media crew employee | ✅ |
| Lend to any other Nerve user (SMC, Creator, Branding) | ✅ — the FK allows it, though nothing scopes it |
| Lend to a faculty member with no Nerve account | ❌ |
| Lend to a student | ❌ |
| Lend to an external party (a hired crew, a vendor) | ❌ |
| Record that a borrower was a student *at the time of the loan* | ❌ |
| Keep a borrower's name in history after they leave | ⚠️ only while the `users` row survives |

The last row is the subtle one. Even for employees, custody history today is only as
durable as the `users` row it points at. The crew-lifecycle suite shows deactivation
preserves transactions — but a genuine deletion would cascade or orphan them.

### The workaround that must not happen

The obvious shortcut is to create `users` rows for students with a junk password and a
made-up email. It should be refused explicitly:

- it puts non-employees into every query that means "our people" — `assignableMemberIds()`, the Team Directory, `/state`'s crew roster, the leave and KRA modules;
- it creates credentials for people who should not have any, which is a standing security liability;
- `email UNIQUE` breaks on students who share a family address or have none;
- it makes "how many people work here?" unanswerable.

---

## 4. Recommended architecture: a borrower is a party, not a user

Introduce **`mo_borrowers`** — one row per person or organisation that may hold an
asset. A borrower *may* be backed by a Nerve user; it does not have to be.

```
mo_borrowers
  id             BIGINT PK
  kind           TEXT CHECK (kind IN ('employee','faculty','student','external','department'))
  user_id        TEXT NULL REFERENCES users(id)      -- set for employees; NULL otherwise
  display_name   TEXT NOT NULL                       -- captured at creation, never derived
  identifier     TEXT                                -- enrolment no. / staff no. / passport
  email          TEXT
  phone          TEXT
  department_id  BIGINT REFERENCES mo_departments(id)
  campus_id      BIGINT REFERENCES mo_campuses(id)
  is_active      BOOLEAN NOT NULL DEFAULT true
  notes          TEXT
  created_at / created_by / archived_at
```

Constraints worth stating now:

- `UNIQUE (user_id) WHERE user_id IS NOT NULL` — one borrower per Nerve user, so a
  colleague cannot end up with two borrowing identities.
- `UNIQUE (kind, identifier) WHERE identifier IS NOT NULL` — one enrolment number is
  one student.
- `kind='employee'` requires `user_id IS NOT NULL`; the other kinds require it to be
  NULL. Enforced as a CHECK, so the two worlds cannot blur.

### Relationship to Nerve users

`users` stays exactly what it is: **people who sign into Nerve**. `mo_borrowers` is
**people who may hold equipment**. They overlap for employees and are disjoint
everywhere else.

```
users  ──1:0..1──▶  mo_borrowers  ──1:N──▶  mo_equipment_transactions
                         ▲
                         └── faculty / students / external: no users row at all
```

An employee's borrower row is created automatically the first time they borrow
something, from their `users` row. Nobody maintains two directories.

### Relationship to students and faculty

Deliberately **not** an academic directory. Nerve has no student information system
and should not grow one as a side effect of lending cameras. A student borrower row
holds a name, an enrolment number, a campus and a contact — the minimum needed to
chase a lens. If the university's SIS is ever integrated, `identifier` is the join
key and no history has to move.

---

## 5. How historical transactions preserve borrower identity

This is the part that is easy to get wrong, and the reason for `display_name` above.

**The ledger denormalises the borrower's name at the moment of the loan.**

```
mo_equipment_transactions
  borrower_id        BIGINT NOT NULL REFERENCES mo_borrowers(id)   -- new
  borrower_name_at   TEXT   NOT NULL                                -- captured, never joined
  holder_id          TEXT   NULL REFERENCES users(id)               -- KEPT, see §6
```

Three reasons:

1. **History must not change when a person does.** A student who marries and changes
   their name should not retroactively alter who borrowed a camera in 2026. A join
   would do exactly that.
2. **History must survive the borrower record being archived**, and must not depend on
   a row somebody may later purge under a data-retention policy.
3. **It makes the ledger readable on its own.** An audit should not need five joins to
   say who had what.

The borrower row remains the live identity — current contact details, whether they may
borrow again. The ledger row is the historical fact. Live state and historical record
are different questions and get different columns.

**`mo_borrowers` rows are never hard-deleted** while transactions reference them;
`archived_at` is the end state, exactly as retirement is for an asset.

---

## 6. Migration path, and why `holder_id` is not dropped

The additive, reversible order:

1. Create `mo_borrowers`. Backfill one row per `users` row that appears as a
   `holder_id` in the ledger, `kind='employee'`.
2. Add `borrower_id` and `borrower_name_at` to `mo_equipment_transactions`, nullable.
3. Backfill both from the existing `holder_id`.
4. Make them `NOT NULL` once the backfill is verified.
5. Write both `borrower_id` and `holder_id` for employee loans.
6. **Keep `holder_id`, nullable, indefinitely.** It stays correct for every employee
   loan, every existing query keeps working, and it is the rollback. Reservations
   likewise gain `borrower_id` beside `user_id`.

Nothing is dropped in the migration that introduces the model. Dropping `holder_id` is
a separate, later decision that should only be taken once nothing reads it.

### Reservations

`mo_equipment_bookings.user_id` becomes `borrower_id` by the same additive route. The
GIST exclusion constraint is untouched — it keys on `equipment_item_id` and the date
range, not on who booked.

---

## 7. What this buys, and what it costs

**Buys:** students, faculty and external borrowers without giving anybody a login;
custody history that survives a name change, an archive and a departure; a per-borrower
overdue and lending record that works the same for a student and an employee;
department-scoped lending for §13's two domains.

**Costs:** one more table and one more concept; a borrower-picker in the checkout UI;
a policy decision about who may create a student borrower record; a data-retention
question about holding student contact details, which is a genuine privacy matter and
should be answered before the table is created, not after.

---

## 8. Decisions needed before implementation

1. Who may create a **student** borrower — custodian only, or any crew member at the point of lending?
2. Does a student loan need an **approving faculty member** recorded on the transaction?
3. What is the **retention period** for a student borrower's contact details after their last loan?
4. Should an external borrower require a **deposit or an agreement reference**?
5. Is the **enrolment number** authoritative and available at the cupboard, or will staff be typing names?

These are policy questions, not engineering ones, and the schema above deliberately
leaves room for each answer without changing the ledger.

---

## 9. Recommendation

Adopt the borrower-party model. Build it as **Phase 6** of the stabilisation roadmap,
not sooner — but treat §5 and §6 of this note as **binding on Phase 3**, so that when
check-out and check-in were hardened they did not freeze a shape that has to be undone.

That constraint has already been honoured: the current implementation resolves custody
server-side through a single `resolveHolder()` function and a kiosk session, rather
than scattering `holder_id` handling across handlers. When `borrower_id` arrives, it
is that one function that changes.
