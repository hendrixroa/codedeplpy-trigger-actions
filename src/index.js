const axios = require('axios');
const AWS = require('aws-sdk');
const FunctionShield = require('@puresec/function-shield');
const lz = require('lz-string');
const logger = require('pino')();

const ENV = process.env;
const slackInfraAlertBot = ENV.slack_infra_alert_bot;
const swaggerUrl = ENV.swagger_url;
const apiId = ENV.api_id;
const apiType = ENV.api_type;
const apiStage = ENV.api_stage;
const apiDomain = ENV.api_domain;
const webhookDocs = ENV.webhook_docs;
const slackChannel = ENV.slack_channel;

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

    try {

        await deployAPIGateway();

        let postData = {
            channel: `#${slackChannel}`,
            username: 'AWS Deploy',
            icon_emoji: ':tada:',
            mrkdwn: true
        };

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

        postData.attachments = [
            {
                color: severity,
                author_name: `DEPLOYMENT - ${stage.toUpperCase()}`,
                text: `*${appName}*: ${commit} (<${link}|Codedeploy>)`,
                mrkdwn_in: ['text'],
            }
        ];

        const options = {
            method: 'post',
            url: 'https://slack.com/api/chat.postMessage',
            data: postData,
            headers: {
                'Authorization': `Bearer ${slackInfraAlertBot}`
            }
        };

        await doRequest(options);
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

    // Deploy docs
    await deployDocs(results.data)

    const swaggerContentAWS = addAWSIntegration(results.data);

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

function addAWSIntegration(fileContent) {

    Object.keys(fileContent.paths).map(path => {
        Object.keys(fileContent.paths[path]).map(method => {
            const awsIntegration = {
                connectionId: '${stageVariables.vpcLinkId}',
                connectionType: 'VPC_LINK',
                httpMethod: `${method.toUpperCase()}`,
                passthroughBehavior: 'when_no_match',
                requestTemplates: {
                    'application/json': '{"statusCode": 200}',
                },
                responses: {
                    default: {
                        responseTemplates: {
                            'application/json': '{"statusCode": 200}',
                        },
                        statusCode: '200',
                    },
                },
                type: 'http_proxy',
                uri:
                    'http://${stageVariables.nlbDnsName}:${stageVariables.port}' + path,
            };
            /**
             * Convert to binary for media paths
             */
            const produces = fileContent.paths[path][method].produces;
            if (
                produces &&
                Array.isArray(produces) &&
                produces.includes('image/png')
            ) {
                awsIntegration.contentHandling = 'CONVERT_TO_BINARY';
            }
            if (path.includes('{')) {
                // Contains path params
                const requestParams = {};
                // Get all params passed by path
                const matches = path.match(/{(.*?)}/g) || [];
                matches.forEach(param => {
                    // Replaces the {/} chars
                    const item = param.replace(/({|})/g, '');
                    requestParams[
                        `integration.request.path.${item}`
                        ] = `method.request.path.${item}`;
                });
                awsIntegration.requestParameters = requestParams;
            }
            fileContent.paths[path][method][
                'x-amazon-apigateway-integration'
                ] = awsIntegration;
            /**
             * Added options method to all paths.
             */
            fileContent.paths[path].options = {
                description: 'Enable CORS by returning correct headers\n',
                responses: {
                    200: {
                        description: 'Default response for CORS method',
                        headers: {
                            'Access-Control-Allow-Headers': {
                                schema: {
                                    type: 'string',
                                },
                            },
                            'Access-Control-Allow-Methods': {
                                schema: {
                                    type: 'string',
                                },
                            },
                            'Access-Control-Allow-Origin': {
                                schema: {
                                    type: 'string',
                                },
                            },
                        },
                        content: {},
                    },
                },
                summary: 'CORS support',
                tags: ['CORS'],
                'x-amazon-apigateway-integration': {
                    requestTemplates: {
                        'application/json': '{\n  "statusCode" : 200\n}\n',
                    },
                    responses: {
                        default: {
                            responseParameters: {
                                'method.response.header.Access-Control-Allow-Headers':
                                    "'*'",
                                'method.response.header.Access-Control-Allow-Methods': "'*'",
                                'method.response.header.Access-Control-Allow-Origin': "'*'",
                            },
                            responseTemplates: {
                                'application/json': '{}\n',
                            },
                            statusCode: '200',
                        },
                    },
                    type: 'mock',
                },
            };
        });
    });

    return fileContent;
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