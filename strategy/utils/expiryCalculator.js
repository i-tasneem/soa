// ============================================================
// EXPIRY CALCULATOR
// Calculates weekly and monthly expiry dates for Indian indices
// ============================================================

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

class ExpiryCalculator {
  constructor(profile) {
    this.profile = profile || {};
    this.expiryType = profile?.expiryType || 'weekly';
    this.expiryDayOfWeek = profile?.expiryDayOfWeek || 2; // Tuesday default
  }

  getCurrentExpiry(istDate) {
    const d = istDate ? new Date(istDate) : new Date();
    if (this.expiryType === 'weekly') {
      return this._getWeeklyExpiry(d);
    } else {
      return this._getMonthlyExpiry(d);
    }
  }

  _getWeeklyExpiry(d) {
    // Find the expiryDayOfWeek in the current week
    // If today is past that day, roll to next week
    const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const targetDay = this.expiryDayOfWeek;

    let daysToTarget = targetDay - dayOfWeek;
    if (daysToTarget < 0) {
      daysToTarget += 7;
    }

    const expiryDate = new Date(d);
    expiryDate.setDate(d.getDate() + daysToTarget);

    // Skip weekends (Saturday=6, Sunday=0) — but targetDay should already avoid them
    // If targetDay is weekend, adjust to next valid weekday
    if (targetDay === 0) { // Sunday -> Monday
      expiryDate.setDate(expiryDate.getDate() + 1);
    } else if (targetDay === 6) { // Saturday -> Monday
      expiryDate.setDate(expiryDate.getDate() + 2);
    }

    return this._formatExpiry(expiryDate);
  }

  _getMonthlyExpiry(d) {
    // Find the LAST expiryDayOfWeek of the current month
    const year = d.getFullYear();
    const month = d.getMonth();
    const lastDay = this._getLastDayOfMonth(year, month, this.expiryDayOfWeek);

    // If today is past the last expiry day, roll to next month
    if (d.getDate() > lastDay.getDate()) {
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      return this._formatExpiry(this._getLastDayOfMonth(nextYear, nextMonth, this.expiryDayOfWeek));
    }

    return this._formatExpiry(lastDay);
  }

  _getLastDayOfMonth(year, month, dayOfWeek) {
    // Get last day of month
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const lastDay = lastDayOfMonth.getDate();

    // Walk backwards to find the target day of week
    for (let day = lastDay; day >= 1; day--) {
      const date = new Date(year, month, day);
      if (date.getDay() === dayOfWeek) {
        return date;
      }
    }
    // Fallback: return last day of month
    return lastDayOfMonth;
  }

  _formatExpiry(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = MONTHS[date.getMonth()];
    const year = date.getFullYear();
    return `${day}${month}${year}`;
  }
}

function createExpiryCalculator(profile) {
  return new ExpiryCalculator(profile);
}

module.exports = { ExpiryCalculator, createExpiryCalculator };

// Test block
if (require.main === module) {
  let passed = 0;
  let failed = 0;

  function test(name, actual, expected) {
    if (actual === expected) {
      console.log(`PASS: ${name} => ${actual}`);
      passed++;
    } else {
      console.log(`FAIL: ${name} => expected ${expected}, got ${actual}`);
      failed++;
    }
  }

  // Nifty weekly (Tuesday=2)
  const niftyWeekly = new ExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 2 });
  test('Nifty weekly: June 6, 2026 (Sat) → June 9', niftyWeekly.getCurrentExpiry(new Date(2026, 5, 6)), '09JUN2026');
  test('Nifty weekly: June 9, 2026 (Tue) → June 9', niftyWeekly.getCurrentExpiry(new Date(2026, 5, 9)), '09JUN2026');
  test('Nifty weekly: June 10, 2026 (Wed) → June 16', niftyWeekly.getCurrentExpiry(new Date(2026, 5, 10)), '16JUN2026');

  // BankNifty monthly (Tuesday=2)
  const bankNiftyMonthly = new ExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  test('BankNifty monthly: June 15, 2026 → June 30', bankNiftyMonthly.getCurrentExpiry(new Date(2026, 5, 15)), '30JUN2026');
  test('BankNifty monthly: June 30, 2026 → July 28', bankNiftyMonthly.getCurrentExpiry(new Date(2026, 5, 30)), '28JUL2026');

  // Sensex weekly (Thursday=4)
  const sensexWeekly = new ExpiryCalculator({ expiryType: 'weekly', expiryDayOfWeek: 4 });
  test('Sensex weekly: June 6, 2026 (Sat) → June 11', sensexWeekly.getCurrentExpiry(new Date(2026, 5, 6)), '11JUN2026');

  // Bankex monthly (Thursday=4)
  const bankexMonthly = new ExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 4 });
  test('Bankex monthly: June 15, 2026 → June 25', bankexMonthly.getCurrentExpiry(new Date(2026, 5, 15)), '25JUN2026');

  // Stock option monthly (Tuesday=2)
  const stockMonthly = new ExpiryCalculator({ expiryType: 'monthly', expiryDayOfWeek: 2 });
  test('Stock option: June 20, 2026 → June 30', stockMonthly.getCurrentExpiry(new Date(2026, 5, 20)), '30JUN2026');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
