# Codedeploy trigger actions
AWS Lambda codedeploy actions after receive a message if a deploy was made successfully.

### Main features:

1. Receive a notification from SNS topic after a successful deployment, more info here [SNS-Codedeploy](https://docs.aws.amazon.com/codedeploy/latest/userguide/monitoring-sns-event-notifications-create-trigger.html)
1. Make a request to one (any) API address URL to get Swagger/Openapi json data.
1. Add to that openapi spec the AWS API Gateway integrations to be able deploy to AWS API Gateway give a APIGatewayId.
1. Send a notification to slack workspace you specify, setting the slack-token and channel you will able to receive a notification automatically.

####TODO
- Improve readme.
