-- DigiKavach: wipe all case/citizen data, keep every login account.
--
-- KEEPS (never touched by this script): auth.users, public.profiles.
-- Every officer and civilian account must still be able to log in after
-- running this -- nothing here drops a table, policy, or function, and
-- nothing here deletes a row from auth.users or public.profiles.
--
-- DELETES (all rows, tables/policies/functions left intact):
--   public.evidence, public.complaint_links, public.officer_notes,
--   public.notifications, public.camera_recordings, public.sos_alerts,
--   public.complaints.
--
-- public.safety_map_points is a VIEW over public.complaints, not a table --
-- it has no rows of its own to delete and empties automatically once
-- complaints does.
--
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New
-- query). Listing every DELETE table explicitly in one TRUNCATE statement
-- (rather than relying on an implicit cascade from truncating just
-- `complaints`) means Postgres resolves the foreign-key dependencies for us,
-- and CASCADE is only a safety net in case a future table references one of
-- these -- it can never reach auth.users or profiles, since those are only
-- ever referenced BY these tables, never the other way around.

truncate table
  public.evidence,
  public.complaint_links,
  public.officer_notes,
  public.notifications,
  public.camera_recordings,
  public.sos_alerts,
  public.complaints
cascade;
