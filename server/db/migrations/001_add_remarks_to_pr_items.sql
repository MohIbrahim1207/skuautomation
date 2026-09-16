-- Migration: 001_add_remarks_to_pr_items.sql
-- Purpose: Safely add nullable remarks column to pr_items table for purchase request items.
-- Forward-only and idempotent: Safe to execute multiple times on production without data loss.

ALTER TABLE pr_items ADD COLUMN IF NOT EXISTS remarks TEXT DEFAULT '';
UPDATE pr_items SET remarks = '' WHERE remarks IS NULL;
