// Codedeploy trigger
module "lambda_codedeploy_trigger" {
  source               = "hendrixroa/lambda/aws"
  enabled              = 1
  code_location        = "./src/"
  filename             = "codedeploytrigger.zip"
  lambda_iam_role      = aws_iam_role.lambda_codedeploytrigger.arn
  lambda_function_name = "CodedeployTrigger"
  lambda_runtime       = var.runtime
  timeout              = var.timeout
  memory               = var.memory
  layer_arn            = var.lambda_layer_arn

  subnets = var.subnets
  sg_ids  = [ var.security_group ]

  environment_variables = var.environment_variables
}