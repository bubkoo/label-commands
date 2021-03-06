import * as core from '@actions/core'
import * as github from '@actions/github'
import mustache from 'mustache'
import random from 'lodash.random'
import { Config } from './config'
import { Reaction } from './reaction'

export namespace Util {
  export function getOctokit() {
    const token = core.getInput('GITHUB_TOKEN', { required: true })
    return github.getOctokit(token)
  }

  export function pickComment(
    comment: string | string[],
    args?: { [key: string]: string },
  ) {
    let result: string
    if (typeof comment === 'string' || comment instanceof String) {
      result = comment.toString()
    } else {
      const pos = random(0, comment.length, false)
      result = comment[pos] || comment[0]
    }

    return args ? mustache.render(result, args) : result
  }

  export function isValidEvent(event: string, action?: string) {
    const context = github.context
    const payload = context.payload
    if (event === context.eventName) {
      return action == null || action === payload.action
    }
    return false
  }

  export async function getFileContent(
    octokit: ReturnType<typeof getOctokit>,
    path: string,
  ) {
    try {
      const response = await octokit.repos.getContent({
        ...github.context.repo,
        path,
      })

      const content = response.data.content
      return Buffer.from(content, 'base64').toString()
    } catch (err) {
      return null
    }
  }

  export async function ensureUnlock(
    octokit: ReturnType<typeof getOctokit>,
    callback: (() => void) | (() => Promise<any>),
  ) {
    const context = github.context
    const payload = context.payload.issue || context.payload.pull_request
    if (payload && payload.locked) {
      const params = { ...context.repo, issue_number: payload.number }
      const lockReason = payload.active_lock_reason as Config.LockReason
      await octokit.issues.unlock({ ...params })
      await callback()
      await octokit.issues.lock({
        ...params,
        lock_reason: lockReason,
      })
    } else {
      await callback()
    }
  }

  export async function comment(
    octokit: ReturnType<typeof getOctokit>,
    content: string | string[],
    reactions: string | string[] | undefined,
    data: any,
  ) {
    const context = github.context
    const payload = (context.payload.issue || context.payload.pull_request)!
    const params = { ...context.repo, issue_number: payload.number }
    const body = pickComment(content, {
      ...data,
      author: payload.user.login,
    })

    return ensureUnlock(octokit, async () => {
      const { data } = await octokit.issues.createComment({
        ...params,
        body,
      })

      if (reactions) {
        await Reaction.add(octokit, data.id, reactions)
      }
    })
  }

  export async function label(
    octokit: ReturnType<typeof getOctokit>,
    labels: string | string[],
  ) {
    const labelsToAdd: string[] = []
    const labelsToRemove: string[] = []
    const context = github.context
    const payload = (context.payload.issue || context.payload.pull_request)!
    const params = { ...context.repo, issue_number: payload.number }
    const process = (raw: string) => {
      const handle = (label: string) => {
        if (label.startsWith('-')) {
          labelsToRemove.push(label.substr(1))
        } else {
          labelsToAdd.push(label)
        }

        raw.split(/\s+/).forEach(handle)
      }

      if (Array.isArray(labels)) {
        labels.forEach(process)
      } else {
        process(labels)
      }

      if (labelsToAdd.length) {
        octokit.issues.addLabels({ ...params, labels: labelsToAdd })
      }

      labelsToRemove.forEach((name) => {
        octokit.issues.removeLabel({ ...params, name })
      })
    }
  }

  export async function pin(
    octokit: ReturnType<typeof getOctokit>,
    pinned: boolean,
  ) {
    // https://developer.github.com/v4/input_object/pinissueinput/
    const mutation = pinned
      ? `mutation ($input: PinIssueInput!) {
          pinIssue(input: $input) {
            issue {
              title
            }
          }
        }`
      : `mutation ($input: UnpinIssueInput!) {
          unpinIssue(input: $input) {
            issue {
              title
            }
          }
        }`

    const context = github.context
    const payload = (context.payload.issue || context.payload.pull_request)!
    return octokit.graphql(mutation, {
      input: {
        issueId: payload.node_id,
        clientMutationId: 'top3 pinned',
      },
      headers: {
        Accept: 'application/vnd.github.elektra-preview',
      },
    })
  }
}
