import { Router } from "express";

/**
 * Deterministic date/weekday helpers so agents never have to compute a day-of-week themselves
 * (a frequent source of wrong "Monday vs Tuesday" errors). Pure server-side, no DB.
 *
 * GET /api/utils/weekday?date=YYYY-MM-DD&tz=Europe/Amsterdam
 *   -> { weekday, date, iso, tz }   (date optional; defaults to "now" in tz)
 */
export function utilRoutes() {
  const router = Router();

  router.get("/utils/weekday", (req, res) => {
    const tz = typeof req.query.tz === "string" && req.query.tz.trim() ? req.query.tz.trim() : "UTC";
    const dateStr = typeof req.query.date === "string" ? req.query.date.trim() : "";

    let base: Date;
    if (dateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
      // Anchor at noon UTC so a calendar date never flips across a timezone's midnight.
      base = new Date(`${dateStr}T12:00:00Z`);
      if (Number.isNaN(base.getTime())) {
        res.status(400).json({ error: "invalid date" });
        return;
      }
    } else {
      base = new Date();
    }

    try {
      const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(base);
      const date = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(base);
      const iso = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(base);
      res.json({ weekday, date, iso, tz });
    } catch {
      res.status(400).json({ error: `invalid timezone: ${tz}` });
    }
  });

  return router;
}
