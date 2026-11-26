// Tests send texts by calling the SMS service directly, never on a timer.
process.env.SMS_WORKER = 'off';
process.env.ABSENCE_SMS_DELAY_MINUTES = '0';
delete process.env.KUDISMS_TOKEN;
process.env.SMS_PROVIDER = 'log';
process.env.STORAGE_DRIVER = 'db';
