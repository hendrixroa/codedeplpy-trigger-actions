resource "aws_sns_topic_subscription" "ecs_codedeploytrigger_subscription" {
  topic_arn = var.sns_topic_arn
  protocol  = "lambda"
  endpoint  = module.lambda_codedeploy_trigger.lambda_arn
}

resource "aws_lambda_permission" "allow_invocation_from_sns" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_codedeploy_trigger.lambda_arn
  principal     = "sns.amazonaws.com"
  source_arn    = var.sns_topic_arn
}