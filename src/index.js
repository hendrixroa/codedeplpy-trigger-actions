const axios = require('axios');
const AWS = require('aws-sdk');
const FunctionShield = require('@puresec/function-shield');
const lz = require('lz-string');
const logger = require('pino')();
const awsAPIGTIntegration = require('swagger-aws-api-gateway');
const { WebClient } = require('@slack/web-api');

const ENV = process.env;
const slackInfraAlertBot = ENV.slack_infra_alert_bot;
const swaggerUrl = ENV.swagger_url;
const apiId = ENV.api_id;
const apiType = ENV.api_type;
const apiStage = ENV.api_stage;
const apiDomain = ENV.api_domain;
const webhookDocs = ENV.webhook_docs;
const slackChannel = ENV.slack_channel;
const deployToNetlify = ENV.deploy_to_netlify === 'true' ? true : false;

const slackClient = new WebClient(slackInfraAlertBot);

FunctionShield.configure(
    {
        policy: {
            read_write_tmp: 'alert',
            create_child_process: 'alert',
            outbound_connectivity: 'alert',
            read_handler: 'alert'
        },
        disable_analytics: false,
        token: ENV.function_shield_token
    });

exports.handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;

    // Sleep 3 minute to wait by API deployment switch and reroute traffic
    await sleep(60 * 3000);

    let severity = 'good';
    let message = event.Records[0].Sns.Message;
    let messageJSON = {};
    const stage = await listAlias();

    try {
        messageJSON = JSON.parse(message);
    } catch (error) {
        logger.error(error);
        return context.fail(error);
    }

    let postData = {
        channel: `#${slackChannel}`,
        mrkdwn: true
    };

    try {

        await deployAPIGateway();

        if (messageJSON.status === 'FAILED') {
            severity = 'danger';
        } else if (messageJSON.status === 'STOPPED') {
            severity = 'warning';
        }

        const link = `https://console.aws.amazon.com/codedeploy/home?region=${messageJSON.region}#/deployments/${messageJSON.deploymentId}`;
        const appName = messageJSON.applicationName.split('-')[1].toUpperCase();
        const commit = messageJSON.eventTriggerName;

        // Dont sent message if Deploy is [DEBUG]
        if(commit.startsWith('[DEBUG]')){
            logger.info('No sending messages to Slack because', commit);
            return context.succeed();
        }

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
    } catch (error) {
        logger.error(error);
        return context.fail(error);
    }
};

async function doRequest(options) {
    return axios(options);
}

async function listAlias(){
    const iam = new AWS.IAM();
    const aliases = await iam.listAccountAliases({}).promise();
    return aliases.AccountAliases[0].includes('staging') ? 'staging' : 'production';
}

async function deployAPIGateway() {
    const options = {
        method: 'get',
        url: swaggerUrl,
    };
    const results = await doRequest(options);

    // Deploy docs to netlify
    if(deployToNetlify) {
        await deployDocs(results.data);
    }

    const swaggerContentAWS = awsAPIGTIntegration.addIntegration(results.data);

    const apigateway = new AWS.APIGateway({
        region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
    });

    const paramsUpdateAPI = {
        body: JSON.stringify(swaggerContentAWS),
        failOnWarnings: false,
        mode: 'overwrite',
        parameters: {
            endpointConfigurationTypes: apiType,
        },
        restApiId: apiId,
    };
    await apigateway.putRestApi(paramsUpdateAPI).promise();

    const paramsDeployAPI = {
        restApiId: apiId,
        stageName: apiStage,
        tracingEnabled: true,
    };

    await apigateway
        .createDeployment({ ...paramsDeployAPI })
        .promise();
}

async function deployDocs(fileContent) {
    fileContent['servers'] = [
        {
            url: `https://${apiDomain}/${apiStage}`,
        },
    ];

    // Compress data
    const fileCompressed = lz.compressToBase64(JSON.stringify(fileContent));

    const params = {
        data: fileCompressed,
        method: 'post',
        url: webhookDocs,
    };

    const result = await doRequest(params);
    return result.statusText;
}

function sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}