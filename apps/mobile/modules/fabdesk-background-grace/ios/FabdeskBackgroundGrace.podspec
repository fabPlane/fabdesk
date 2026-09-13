Pod::Spec.new do |s|
  s.name           = 'FabdeskBackgroundGrace'
  s.version        = '0.1.0'
  s.summary        = 'Keeps the fabPlane app alive for a few seconds after backgrounding'
  s.description    = 'beginBackgroundTask on didEnterBackground so a finishing run can still post its local notification.'
  s.author         = 'TensorFleet'
  s.homepage       = 'https://github.com/TensorFleet/fabdesk'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
