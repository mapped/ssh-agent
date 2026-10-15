const core = require('@actions/core');
const child_process = require('child_process');
const fs = require('fs');
const os = require('os');

// Param names
const privateKeyName = 'ssh-private-key';
const repoMappingsName = 'repo-mappings';
const authSockName = 'ssh-auth-sock';
const dropExtraHeaderName = 'drop-extra-header';
const keysInAgentName = 'keys-in-agent';

try {

    const home = os.homedir();
    const homeSsh = home + '/.ssh';
    const sshConfig = homeSsh + '/config';
    const sshKnownHosts = homeSsh + '/known_hosts';

    const privateKey = core.getInput(privateKeyName);

    if (!privateKey) {
        core.setFailed(`The ${privateKeyName} argument is empty. Maybe the secret has not been configured, or you are using a wrong secret name in your workflow file.`);

        return;
    }

    console.log(`Adding GitHub.com keys to ${sshKnownHosts}`);
    fs.mkdirSync(homeSsh, { recursive: true });
    fs.appendFileSync(sshKnownHosts, '\ngithub.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
    fs.appendFileSync(sshKnownHosts, '\ngithub.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=\n');
    fs.appendFileSync(sshKnownHosts, '\ngithub.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=\n');

    console.log("Starting ssh-agent");
    const authSock = core.getInput(authSockName);
    let sshAgentOutput = ''
    if (authSock && authSock.length > 0) {
        sshAgentOutput = child_process.execFileSync('ssh-agent', ['-a', authSock]);
    } else {
        sshAgentOutput = child_process.execFileSync('ssh-agent')
    }

    // Extract auth socket path and agent pid and set them as job variables
    const lines = sshAgentOutput.toString().split("\n")
    for (const lineNumber in lines) {
        const matches = /^(SSH_AUTH_SOCK|SSH_AGENT_PID)=(.*); export \1/.exec(lines[lineNumber])
        if (matches && matches.length > 0) {
            core.exportVariable(matches[1], matches[2])
        }
    }

    // Do we need to drop the http.extraheader added by actions/checkout@v2?
    const dropExtraHeader = (core.getInput(dropExtraHeaderName).toLowerCase() === 'true');
    if (dropExtraHeader) {
        console.log("Dropping any existing http.extraheader git config");
        child_process.execSync(`git config --global http.https://github.com/.extraheader ''`);
    }

    // Grab the repo mappings
    console.log("Parsing repo mappings");
    const repoMappingsInput = core.getInput(repoMappingsName);
    let repoMappings = null;
    if (repoMappingsInput) {
        repoMappings = new Array();
        repoMappingsInput.split(/\r?\n/).forEach(function(key) {
            // Get the hostname, org name, and repo name
            // format expected:  sub.host.com/OWNER/REPO
            let parts = key.trim().match(/(.*)\/(.*)\/(.*)/);
            if (parts.length != 4) {
                throw `Invalid ${repoMappingsName} format at: ${key}`;
            }

            // Add this to the array of mappings
            let mapping = {
                host: parts[1],
                owner: parts[2],
                repo: parts[3],
                pseudoHost: `${parts[3]}.${parts[1]}`
            };
            repoMappings.push(mapping);

            // Create rewrites
            console.log(`Adding insteadOf entries in git config for ${key}`);
            child_process.execSync(`git config --global url."git@http.${mapping.pseudoHost}:${mapping.owner}/${mapping.repo}".insteadOf "https://${mapping.host}/${mapping.owner}/${mapping.repo}"`);
            child_process.execSync(`git config --global url."git@ssh.${mapping.pseudoHost}:${mapping.owner}/${mapping.repo}".insteadOf "git@${mapping.host}:${mapping.owner}/${mapping.repo}"`);
        });
    }

    // With keys-in-agent, a mapped key lives only in the agent: ~/.ssh gets just its public key, which
    // tells ssh which agent key to offer for the repo (IdentitiesOnly). Nothing copied out of ~/.ssh,
    // e.g. into a Docker build context, then carries a private key; builds reach the keys through the
    // forwarded agent socket instead.
    const keysInAgent = (core.getInput(keysInAgentName).toLowerCase() === 'true');

    // Add private keys to ssh-agent
    console.log("Adding private key to agent");
    const privateKeys = privateKey.split(/(?=-----BEGIN)/);
    if (repoMappings && privateKeys.length != repoMappings.length) {
        core.setFailed(`The number of ${privateKeyName} arguments and ${repoMappingsName} must match.`);

        return;
    }

    privateKeys.forEach(function(key, i) {
        if (repoMappings) {
            let mapping = repoMappings[i];
            let keyFile = `${mapping.pseudoHost}.key`;
            const keyData = key.replace("\r\n", "\n").trim() + "\n";

            if (keysInAgent) {
                // A private key file left by an earlier run without keys-in-agent must not stay behind.
                fs.rmSync(`${homeSsh}/${keyFile}`, { force: true });
                child_process.execSync('ssh-add -', { input: keyData });
                // ssh-keygen cannot open /dev/stdin on the socket node hands a child as stdin; cat makes it a pipe.
                const publicKey = child_process.execFileSync('sh', ['-c', 'cat | ssh-keygen -y -f /dev/stdin'], { input: keyData }).toString();
                keyFile = `${keyFile}.pub`;
                fs.writeFileSync(`${homeSsh}/${keyFile}`, publicKey, { mode: '644' });
            } else {
                // A public key left by an earlier keys-in-agent run would be offered instead of this key
                // (OpenSSH reads the .pub next to an IdentityFile), so it must not stay behind either.
                fs.rmSync(`${homeSsh}/${keyFile}.pub`, { force: true });
                // Since we can't specify hostname/user/host options in a ssh-add call...
                // Write the key to a file
                fs.writeFileSync(`${homeSsh}/${keyFile}`, keyData, { mode: '600' });
            }

            // Update ssh config
            let hostEntry = `\nHost http.${mapping.pseudoHost}\n`
                          + `    HostName ${mapping.host}\n`
                          + `    User git\n`
                          + `    IdentityFile ~/.ssh/${keyFile}\n`
                          + `    IdentitiesOnly yes\n`
                          + `\nHost ssh.${mapping.pseudoHost}\n`
                          + `    HostName ${mapping.host}\n`
                          + `    User git\n`
                          + `    IdentityFile ~/.ssh/${keyFile}\n`
                          + `    IdentitiesOnly yes\n`;

            fs.appendFileSync(sshConfig, hostEntry);
        } else {
            // No mappings, just use ssh-add
            child_process.execSync('ssh-add -', { input: key.trim() + "\n" });
        }
    });

    console.log("Keys added:");
    if (repoMappings) {
        repoMappings.forEach(function(key) {
            console.log(`~/.ssh/${key.pseudoHost}.key${keysInAgent ? '.pub (private key in the agent)' : ''}`);
        });
    } else {
        child_process.execSync('ssh-add -l', { stdio: 'inherit' });
    }

} catch (error) {
    core.setFailed(error.message);
}
