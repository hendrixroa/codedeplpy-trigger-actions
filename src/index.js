const AWS = require('aws-sdk');
const logger = require('pino')();
const { WebClient } = require('@slack/web-api');

const ENV = process.env;
const slackInfraAlertBot = ENV.slack_infra_alert_bot;
const slackChannel = ENV.slack_channel;
const silent = ENV.silent && ENV.silent === "true" ? true : false;

const slackClient = new WebClient(slackInfraAlertBot);

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    let severity = 'good';
    let message = event.Records[0].Sns.Message;
    let messageJSON = {};
    const stage = await listAlias();

    try {
        logger.info('Message received' + JSON.stringify(message));
        messageJSON = JSON.parse(message);
    } catch (error) {
        return context.succeed();
    }

    let postData = {
        channel: slackChannel,
        mrkdwn: true
    };
    const appName = messageJSON.applicationName.split('-')[1].toUpperCase();

    try {

        if (messageJSON.status === 'FAILED') {
            severity = 'danger';
        } else if (messageJSON.status === 'STOPPED') {
            severity = 'warning';
        }

        const link = `https://console.aws.amazon.com/codedeploy/home?region=${messageJSON.region}#/deployments/${messageJSON.deploymentId}`;
        const commit = messageJSON.eventTriggerName;

        // Dont sent message if Deploy is [DEBUG]
        if(commit.startsWith('[DEBUG]')){
            logger.info('No sending messages to Slack because', commit);
            return context.succeed();
        }

        if(silent === false) {
            await slackClient.chat.postMessage({
                ...postData,
                attachments: [
                    {
                        color: severity,
                        author_name: `DEPLOYMENT - ${stage.toUpperCase()}`,
                        text: `*${appName}*: ${commit} (<${link}|Codedeploy>)`,
                        mrkdwn_in: 'text',
                    },
                ],
            });
        }
        return context.succeed();
    } catch (error) {
        logger.error(error);
        if(silent === false) {
            await sendAlertError(stage, error.message);
        }
        return context.fail(error);
    }
};

async function listAlias(){
    const iam = new AWS.IAM();
    const aliases = await iam.listAccountAliases({}).promise();
    return aliases.AccountAliases[0].includes('staging') ? 'staging' : 'production';
}

async function sendAlertError(stage, message) {
    await slackClient.chat.postMessage({
        channel: slackChannel,
        mrkdwn: true,
        attachments: [
            {
                color: 'danger',
                author_name: `POST_DEPLOYMENT - ${stage.toUpperCase()}`,
                text: `${message}`,
                mrkdwn_in: 'text',
            },
        ],
    });
}
