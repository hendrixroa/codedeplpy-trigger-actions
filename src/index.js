const axios = require('axios');
const AWS = require('aws-sdk');
const FunctionShield = require('@puresec/function-shield');
const logger = require('pino')();
const APIGatewayIntegrator = require('swagger-aws-api-gateway').default;
const { WebClient } = require('@slack/web-api');

const ENV = process.env;
const slackInfraAlertBot = ENV.slack_infra_alert_bot;
const swaggerUrl = ENV.swagger_url;
const apiId = ENV.api_id;
const apiType = ENV.api_type;
const apiStage = ENV.api_stage;
const apiDomain = ENV.api_domain;
const slackChannel = ENV.slack_channel;

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

        // Filter out non-api-task
        if(appName.includes('api')) {
            await deployAPIGateway();
        }

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
        return context.succeed();
    } catch (error) {
        logger.error(error);
        await sendAlertError(stage, error.message);
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

    const awsGWInstance = new APIGatewayIntegrator(results.data);
    const swaggerContentAWS = await awsGWInstance.addIntegration();
    await deployDocs(results.data);

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

async function deployDocs(spec) {
    spec['servers'] = [
        {
            url: `https://${apiDomain}/${apiStage}`,
        },
    ];
    const s3Instance = new AWS.S3({
        region: ENV.AWS_DEFAULT_REGION || 'us-east-1',
    });
    await s3Instance
        .putObject({
            ACL: 'private',
            Body: JSON.stringify(spec),
            Bucket: ENV.docs_bucket,
            Key: 'swagger/swagger.json',
        })
        .promise();

    const taskName = ENV.ecs_task.split('/')[1].split(':')[0];
    const params = {
        cluster: ENV.ecs_cluster,
        taskDefinition: taskName,
        capacityProviderStrategy: [
            {
                capacityProvider: 'FARGATE_SPOT',
                weight: 1,
            },
        ],
        networkConfiguration: {
            awsvpcConfiguration: {
                subnets: [ENV.subnet],
                assignPublicIp: 'DISABLED',
                securityGroups: [ENV.sg],
            },
        },
    };
    const ecsInstance = new AWS.ECS({
        region: ENV.AWS_DEFAULT_REGION || 'us-east-1',
    });
    const resultTask = await ecsInstance.runTask(params).promise();
    logger.info('Result deploy docs', resultTask);
}

function sleep (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
