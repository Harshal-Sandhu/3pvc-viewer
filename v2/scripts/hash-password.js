const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
    return new Promise(resolve => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        stdout.write(question);
        stdin.resume();
        stdin.setRawMode(true);
        let input = '';
        const onData = (ch) => {
            const s = ch.toString();
            if (s === '\n' || s === '\r' || s === '') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                stdout.write('\n');
                resolve(input);
            } else if (s === '') {
                process.exit(1);
            } else if (s === '') {
                input = input.slice(0, -1);
            } else {
                input += s;
                stdout.write('*');
            }
        };
        stdin.on('data', onData);
    });
}

(async () => {
    const pw = await ask('Password: ');
    const confirm = await ask('Confirm:  ');
    if (pw !== confirm) {
        console.error('Passwords do not match.');
        process.exit(1);
    }
    if (pw.length < 10) {
        console.error('Password must be at least 10 characters.');
        process.exit(1);
    }
    const hash = bcrypt.hashSync(pw, 12);
    console.log('\nAdd this to your .env file:');
    console.log('ADMIN_PASSWORD_HASH=' + hash);
    rl.close();
})();
