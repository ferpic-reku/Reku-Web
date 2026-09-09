-- Final report only, encrypted; never raw messages or audio. Test mode writes neither.
ALTER TABLE consultation_bot_usage ADD COLUMN IF NOT EXISTS report_encrypted TEXT;
