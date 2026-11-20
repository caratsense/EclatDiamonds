import 'reflect-metadata';
import { CronJob } from 'cron';
import { MlInferenceService } from './ml-inference.service';

describe('inference keep-warm', () => {
  it('pings every five minutes in shop hours, India time, and never overnight', () => {
    // Exactly what @Cron registers, so dropping the zone from the decorator fails here.
    const { cronTime, timeZone } = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', MlInferenceService.prototype.keepWarm);
    // Railway runs in UTC: without the zone "10-20" would be 3:30pm–2:30am here.
    expect(timeZone).toBe('Asia/Kolkata');
    const job = CronJob.from({ cronTime, onTick: () => undefined, start: false, timeZone });
    // A week of pings, as minutes past midnight in India.
    const minutes = job.nextDates(7 * 24 * 12).map((d) => {
      const ist = d.setZone('Asia/Kolkata');
      return ist.hour * 60 + ist.minute;
    });
    expect(Math.min(...minutes)).toBe(10 * 60);
    expect(Math.max(...minutes)).toBe(20 * 60 + 55);
    // Every five minutes in between, so it never idles long enough to fall asleep.
    expect(new Set(minutes).size).toBe(11 * 12);
  });
});
