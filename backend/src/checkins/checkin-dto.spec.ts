import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateCheckInDto } from './dto/checkin.dto';

/**
 * The walk-in review made the phone number mandatory. It is mandatory for a
 * named visitor and must stay that way — but "Customer didn't share details"
 * is a real counter workflow, and making the rule unconditional rejected every
 * such check-in with a 400 while the form still offered the option.
 */
describe('CreateCheckInDto — phone vs anonymous', () => {
  const base = { storeId: 'mumbai-bandra', customerName: 'Priya Shah' };
  const errorsFor = (payload: Record<string, unknown>) =>
    validateSync(plainToInstance(CreateCheckInDto, payload))
      .flatMap((e) => Object.keys(e.constraints ?? {}).map(() => e.property));

  it('rejects a named walk-in with no number', () => {
    expect(errorsFor(base)).toContain('phone');
  });

  it('accepts an anonymous walk-in with no number', () => {
    expect(errorsFor({ ...base, anonymous: true })).not.toContain('phone');
  });

  it('still rejects a malformed number on an anonymous walk-in', () => {
    // Opting out of the number is not a licence to store a broken one.
    expect(errorsFor({ ...base, anonymous: true, phone: '123' })).toContain('phone');
  });

  it('accepts a named walk-in with a valid number', () => {
    expect(errorsFor({ ...base, phone: '9876543210' })).not.toContain('phone');
  });

  it('accepts an international number', () => {
    expect(errorsFor({ ...base, phone: '+14155552671' })).not.toContain('phone');
  });
});
