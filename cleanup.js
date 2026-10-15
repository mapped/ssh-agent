import * as core from '@actions/core'
import { execSync } from 'child_process'

try {
    // Kill the started SSH agent
    core.info('Stopping SSH agent')
    execSync('kill ${SSH_AGENT_PID}', { stdio: 'inherit' })
} catch (error) {
    core.warning(error.message);
    core.warning('Error stopping the SSH agent, proceeding anyway');
}
