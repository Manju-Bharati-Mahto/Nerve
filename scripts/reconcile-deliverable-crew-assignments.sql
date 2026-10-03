-- ═══════════════════════════════════════════════════════════════════════════
-- ONE-OFF: retire crew assignments that duplicate mo_deliverables.owner_id
--
-- Before commit ea700aa, the deliverable drawer's "Assign to team member" wrote
-- an mo_assignments row (is_smc = false, deliverable_id set) instead of
-- owner_id. My Day and /status never read those rows, so the person named in
-- them could not see or move the work. owner_id is now the only record of who
-- executes a deliverable; this script brings existing rows into line.
--
-- It is NOT run automatically. Review the preview, then run it for real:
--
--   psql "$DATABASE_URL" -f scripts/reconcile-deliverable-crew-assignments.sql
--
-- It ends in ROLLBACK, so a first run changes nothing and only prints what it
-- would do. Change the last line to COMMIT once the preview reads right.
--
--   fill      owner_id is empty and the row names exactly one crew member
--             → that person becomes the owner and joins the project crew;
--               the row is retired.
--   agree     the row names the person who already owns the deliverable
--             → the row is retired.
--   conflict  the row names someone other than the owner
--             → LEFT ALONE and listed. A lead decides who executes it; the
--               next reassignment in the app retires the row by itself.
--
-- SMC coverage rows (is_smc = true) are never touched. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE crew_dupes ON COMMIT DROP AS
SELECT a.id AS assignment_id, a.deliverable_id, d.project_id, d.title,
       d.owner_id,
       array_agg(au.user_id ORDER BY au.user_id) FILTER (WHERE au.user_id IS NOT NULL) AS crew_users,
       CASE
         WHEN d.owner_id IS NULL AND count(au.user_id) = 1 THEN 'fill'
         WHEN d.owner_id IS NOT NULL AND count(au.user_id) = 1
              AND min(au.user_id) = d.owner_id                THEN 'agree'
         ELSE 'conflict'
       END AS action
  FROM mo_assignments a
  JOIN mo_deliverables d ON d.id = a.deliverable_id AND d.deleted_at IS NULL
  LEFT JOIN mo_assignment_users au ON au.assignment_id = a.id
 WHERE NOT COALESCE(a.is_smc, false) AND a.status <> 'cancelled'
 GROUP BY a.id, a.deliverable_id, d.project_id, d.title, d.owner_id;

\echo '── Preview ───────────────────────────────────────────────────────────────'
SELECT action, assignment_id, deliverable_id, title, owner_id, crew_users
  FROM crew_dupes ORDER BY action, deliverable_id;

-- fill: the named person becomes the owner …
UPDATE mo_deliverables d
   SET owner_id = c.crew_users[1], updated_at = NOW()
  FROM crew_dupes c
 WHERE c.action = 'fill' AND d.id = c.deliverable_id AND d.owner_id IS NULL;

-- … and joins the project crew, as every assignment path now does.
INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager)
SELECT DISTINCT c.project_id, c.crew_users[1], false
  FROM crew_dupes c
 WHERE c.action = 'fill'
ON CONFLICT (project_id, user_id) WHERE removed_at IS NULL DO NOTHING;

-- fill + agree: the duplicate row is retired.
UPDATE mo_assignments a
   SET status = 'cancelled'
  FROM crew_dupes c
 WHERE c.action IN ('fill', 'agree') AND a.id = c.assignment_id;

\echo '── Left for a Team Lead to decide (conflicts) ────────────────────────────'
SELECT assignment_id, deliverable_id, title, owner_id AS current_owner, crew_users AS crew_row_names
  FROM crew_dupes WHERE action = 'conflict' ORDER BY deliverable_id;

ROLLBACK;   -- change to COMMIT to apply
