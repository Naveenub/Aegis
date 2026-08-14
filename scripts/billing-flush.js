#!/usr/bin/env node
/**
 * scripts/billing-flush.js
 *
 * Flushes unreported metered usage (engine/usage-recorder.js) to Stripe
 * (engine/billing/stripe-reporter.js). Run on a schedule — e.g. hourly cron
 * or a k8s CronJob — separate from the request/worker hot path.
 *
 *   npm run billing:flush
 */
import dotenv from 'dotenv';
import { flushUsageToStripe } from '../engine/billing/stripe-reporter.js';

dotenv.config();

const result = await flushUsageToStripe();
console.log(`[billing-flush] reported=${result.reported} skipped=${result.skipped} failed=${result.failed}`);
process.exit(result.failed > 0 ? 1 : 0);
