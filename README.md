# Time Clock

A home-screen iPhone app for clocking in and out and making invoices. It replaces the TIME.numbers spreadsheet and the Shortcut that fed it.

- **Clock**: pick Standard or Driving, type or tap a client, then press Clock In. Clock Out ends the shift. "Switch" clocks out and gets you ready for the next leg (for example, drive → job).
- **Log**: every entry in the pay period. Tap one to fix times. Shifts that end after midnight are handled.
- **Invoice**: builds the invoice for the pay period, then lets you share it as a PDF (Mail, Messages, Files) or export a CSV.
- **Settings**: names and addresses, rates, pay periods, backup and restore.

## Billing rules (copied from the Numbers sheet)
- Standard is $30/hr. Driving is $20/hr.
- Every minute of driving is billed. There's no unpaid first half hour.
- Punches are saved at the real time. Billing rounds them to the nearest 15 minutes.
- Pay periods are 2 weeks long, counted from Mon Dec 15 2025, which was invoice #02. Each period after that adds one to the invoice number. You can change the number on the Invoice tab.

## Install
Open the site in Safari, then tap Share → Add to Home Screen. All data stays on the phone, in local storage. Use Settings → Back up now and then.

Plain HTML, CSS and JS with no build step. jsPDF is bundled in `vendor/`.
