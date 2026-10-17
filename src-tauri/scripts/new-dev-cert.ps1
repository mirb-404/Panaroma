<#
.SYNOPSIS
  Creates a self-signed code-signing certificate for local test builds.

.DESCRIPTION
  Windows shows builds signed with this as "Unknown publisher" on other PCs;
  public releases need a certificate from a trusted CA (OV/EV) or Azure
  Trusted Signing. Prints the thumbprint to put in PANORAMA_SIGN_THUMBPRINT.
#>
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject 'CN=Mirang Bhandari' `
    -FriendlyName 'Panorama development signing' `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(3)

Write-Host "Created $($cert.Subject), thumbprint $($cert.Thumbprint)"
Write-Host "Use it for this shell with:"
Write-Host "  `$env:PANORAMA_SIGN_THUMBPRINT = '$($cert.Thumbprint)'"
